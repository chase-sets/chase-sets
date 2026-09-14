import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createChannelProviderRegistry,
  module as channelsModule,
  type ChannelProviderDescriptor,
  type ChannelStateLineV1,
} from "@chase-sets/channels";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createChannelActionAttentionSourceFromReadModel } from "@chase-sets/channels/server";
import type { ChannelHealthObservation } from "@chase-sets/channels/server";
import { aggregateSellerAttentionQueue } from "@chase-sets/seller-attention-queue";
import { module as inventoryModule } from "@chase-sets/inventory";
import {
  createInventoryExternalChannelSaleRecorderForPool,
  type RecordExternalChannelSale,
} from "@chase-sets/inventory/server";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import {
  accountScopedWorkerContext,
  createChannelsReconciliationRunners,
  createPlatformChannelSaleRecorder,
} from "../src/channels-reconciliation-runners";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for the Channels reconciliation worker DB test in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels" | "inventory" | "control", PgTransactionalPool>>;
const providerWrite = vi.fn(async (): Promise<never> => {
  throw new Error("Synthetic provider write is forbidden in reconciliation.");
});

describeDb("Channels reconciliation real scheduled runner", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels", "inventory", "control"],
      "channels_reconciliation_runner",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    providerWrite.mockClear();
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapPlatformControlPlane(pools.control);
  });

  afterAll(async () => closeMultiContextTestPools(pools));
  afterEach(() => expect(providerWrite).not.toHaveBeenCalled());

  it("channel-seeded-drift-drill uses the real scheduler, composition, queue, and account-scoped Inventory authority", async () => {
    await seedInventoryItem(pools.inventory);
    await seedChannelDrift(pools.channels);
    const channelSaleRecorder = createPlatformChannelSaleRecorder(pools.inventory);
    const services = channelsModule.createServices(pools.channels, { channelSaleRecorder });
    const [runner] = createChannelsReconciliationRunners({
      services,
      controlPlane: createPostgresPlatformControlPlane(pools.control),
      registry: syntheticRegistry(),
    });

    const windowFrom = new Date(Date.now() - 60_000).toISOString();
    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    const windowTo = new Date(Date.now() + 60_000).toISOString();
    await expect(
      services.reconciliation.readChannelReconciliationMetrics({
        accountId: "account-1",
        connectionId: "connection-1",
        window: { from: windowFrom, to: windowTo },
      }),
    ).resolves.toMatchObject({
      runsCompleted: 1,
      counts: { listingsReconciled: 3, repairable: 1, foreignEdit: 1, structural: 1, repairsEnqueued: 1 },
    });
    await expect(
      services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({ affectedListingCount: 2, hasMore: 0, resolution: null });
    const source = createChannelActionAttentionSourceFromReadModel(pools.channels);
    await expect(source.load({ accountId: "account-1", now: windowTo })).resolves.toMatchObject([
      {
        id: "channel-action:connection-1",
        summary: {
          code: "channel-action-open",
          params: { reasonCount: 1, topReason: "drift", affectedListingCount: 2, hasMore: 0 },
        },
      },
    ]);
    await expect(
      pools.channels.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM channel_outbound_operations WHERE status='pending'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(
      pools.inventory.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM event_store_events
       WHERE event_type='inventory.external-channel-sale.recorded'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });

    await proveInboundIgnoresEveryHoldCombination(channelSaleRecorder);
    const systemBound = createInventoryExternalChannelSaleRecorderForPool(pools.inventory, systemContext);
    await expect(systemBound(saleCommand("system-refusal"))).rejects.toThrow(
      "External channel sale context must be scoped to the command account.",
    );
  });

  it("S6 partial acceptance preserves the generation fingerprint until every member is settled", async () => {
    await seedInventoryItem(pools.inventory);
    await seedChannelDrift(pools.channels);
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createPlatformChannelSaleRecorder(pools.inventory),
    });
    const observed = [
      state("external-repairable", "foreign-a", 1_200, 1, fingerprint("a")),
      state("external-foreign", "foreign-b", 1_200, 1, fingerprint("b")),
      state("external-structural", "7", 1_000, 2, fingerprint("3")),
    ];
    const [runner] = createChannelsReconciliationRunners({
      services,
      controlPlane: createPostgresPlatformControlPlane(pools.control),
      registry: syntheticRegistry(() => observed),
    });
    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    const opening = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    expect(opening).toMatchObject({ affectedListingCount: 2, resolution: null });
    await services.reconciliation.acceptChannelDrift(
      {
        connectionId: "connection-1",
        channelListingId: "channel-repairable",
        observedFingerprint: fingerprint("a"),
        expectedMaterialFingerprint: fingerprint("1"),
        expectedDecisionRevision: 0,
        operationId: "synthetic-s6-partial-accept",
      },
      accountScopedWorkerContext("account-1"),
    );
    await makeNextRunDue(1);
    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    const partial = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    expect(partial).toMatchObject({ resolution: null, generation: opening!.generation });
    expect(partial!.fingerprint).toBe(opening!.fingerprint);
    expect(
      (
        await pools.channels.query(
          "DELETE FROM event_store_aggregate_snapshots WHERE stream_id='channels.channel-reconciliation-connection-1' RETURNING stream_id",
        )
      ).rows,
    ).toHaveLength(1);
    await makeNextRunDue(2);
    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toEqual(partial);
  });

  it("S6 producer accepts the actual current health policy and evaluation identities without a cast", async () => {
    await seedInventoryItem(pools.inventory);
    await seedChannelDrift(pools.channels);
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createPlatformChannelSaleRecorder(pools.inventory),
    });
    const current = await services.connectionHealth.readConnectionHealth({
      accountId: "account-1",
      connectionId: "connection-1",
    });
    expect(current.policyAvailable).toBe(true);
    expect(current.health.policyRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(current.health.evaluationGeneration).toBeGreaterThan(0);
    await expect(
      services.reconciliation.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: syntheticRegistry(),
          sourceAttempt: 1,
          healthAuthority: current.health,
        },
        accountScopedWorkerContext("account-1"),
      ),
    ).resolves.toMatchObject({ state: "completed" });
  });

  it("S6 structural membership survives an intermediate repair before the remaining foreign edit is accepted", async () => {
    await seedInventoryItem(pools.inventory);
    await seedChannelDrift(pools.channels);
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createPlatformChannelSaleRecorder(pools.inventory),
    });
    let observed = [
      state("external-repairable", "7", 1_000, 2, fingerprint("1")),
      state("external-foreign", "foreign", 1_200, 1, fingerprint("b")),
    ];
    const [runner] = createChannelsReconciliationRunners({
      services,
      controlPlane: createPostgresPlatformControlPlane(pools.control),
      registry: syntheticRegistry(() => observed),
    });
    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    await expect(
      services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({ affectedListingCount: 2, resolution: null });
    observed = [...observed, state("external-structural", "7", 1_000, 2, fingerprint("3"))];
    await makeNextRunDue(1);
    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    await expect(
      services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({ affectedListingCount: 1, resolution: null });
    await services.reconciliation.acceptChannelDrift(
      {
        connectionId: "connection-1",
        channelListingId: "channel-foreign",
        observedFingerprint: fingerprint("b"),
        expectedMaterialFingerprint: fingerprint("2"),
        expectedDecisionRevision: 0,
        operationId: "synthetic-s6-final-accept",
      },
      accountScopedWorkerContext("account-1"),
    );
    await makeNextRunDue(2);
    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    await expect(
      services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({ affectedListingCount: 0, resolution: "recovered-automatically" });
  });

  it("S6 complete acceptance resolves only after next confirmation through real health and attention", async () => {
    const { services, runner } = await startTwoForeign();
    await runner.runOnce();
    const opening = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    await accept(services, "repairable", "a", "1");
    await makeNextRunDue(1);
    await runner.runOnce();
    await accept(services, "foreign", "b", "2");
    const source = createChannelActionAttentionSourceFromReadModel(pools.channels);
    expect(await source.load({ accountId: "account-1", now: new Date().toISOString() })).toHaveLength(1);
    await makeNextRunDue(2);
    await runner.runOnce();
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toMatchObject({
      generation: opening!.generation,
      fingerprint: opening!.fingerprint,
      resolution: "handled-on-channel",
    });
    expect(await source.load({ accountId: "account-1", now: new Date().toISOString() })).toEqual([]);
    expect(
      await services.connectionHealth.readConnectionHealth({ accountId: "account-1", connectionId: "connection-1" }),
    ).toMatchObject({
      systemPaused: false,
      health: { state: "unknown", reasons: [{ reasonCode: "drift", state: "closed" }] },
    });
    expect((await pools.channels.query("SELECT resolution_reason FROM channel_connection_attention")).rows).toEqual([
      { resolution_reason: "handled-on-channel" },
    ]);
  });

  it("S6 candidate versus dropped scheduled consumer exposes omission and durable redelivery", async () => {
    const { services } = await startTwoForeign();
    const omitted = {
      ...services,
      reconciliation: { ...services.reconciliation, deliverHealthObservations: async () => ({ consumed: 0 }) },
    };
    const [runner] = createChannelsReconciliationRunners({
      services: omitted,
      controlPlane: createPostgresPlatformControlPlane(pools.control),
      registry: syntheticRegistry(twoForeign),
    });
    await runner!.runOnce();
    const source = createChannelActionAttentionSourceFromReadModel(pools.channels);
    expect(await source.load({ accountId: "account-1", now: new Date().toISOString() })).toEqual([]);
    const pending = await services.reconciliation.readPendingHealthObservations({});
    expect(pending).toHaveLength(1);
    expect(
      await services.reconciliation.deliverHealthObservations(services.connectionHealth, accountScopedWorkerContext),
    ).toEqual({ consumed: 1 });
    expect(await source.load({ accountId: "account-1", now: new Date().toISOString() })).toHaveLength(1);
    expect(await services.reconciliation.readPendingHealthObservations({})).toEqual([]);
    expect(
      await services.reconciliation.deliverHealthObservations(services.connectionHealth, accountScopedWorkerContext),
    ).toEqual({ consumed: 0 });
    expect(
      await services.connectionHealth.submitObservation(pending[0]!, accountScopedWorkerContext("account-1")),
    ).toMatchObject({ outcome: "replayed" });
  });

  it("S6 real intake preserves replay later-attempt conflict stale and foreign-account boundaries", async () => {
    const { services, runner } = await startTwoForeign();
    await runner.runOnce();
    const observation = (
      await pools.channels.query<{ payload: ChannelHealthObservation }>(
        "SELECT payload FROM channel_reconciliation_health_observations ORDER BY occurred_at LIMIT 1",
      )
    ).rows[0]!.payload;
    const context = accountScopedWorkerContext("account-1");
    expect(await services.connectionHealth.submitObservation(observation, context)).toMatchObject({
      outcome: "replayed",
    });
    expect(
      await services.connectionHealth.submitObservation({ ...observation, sourceAttempt: 2 }, context),
    ).toMatchObject({ outcome: "accepted", health: { health: { reasons: [{ consecutiveFailures: 2 }] } } });
    const before = (await pools.channels.query("SELECT * FROM channel_connection_health")).rows;
    expect(
      await services.connectionHealth.submitObservation({ ...observation, outcome: "success" }, context),
    ).toMatchObject({ outcome: "conflicting-terminal" });
    expect(
      await services.connectionHealth.submitObservation({ ...observation, policyRevision: fingerprint("e") }, context),
    ).toMatchObject({ outcome: "stale" });
    await expect(
      services.connectionHealth.submitObservation(observation, accountScopedWorkerContext("foreign-account")),
    ).rejects.toThrow();
    expect((await pools.channels.query("SELECT * FROM channel_connection_health")).rows).toEqual(before);
    expect(
      await createChannelActionAttentionSourceFromReadModel(pools.channels).load({
        accountId: "foreign-account",
        now: new Date().toISOString(),
      }),
    ).toEqual([]);
  });

  it("S6 genuine observed fingerprint change opens exactly the next producer and health generation", async () => {
    let observed = twoForeign();
    const { services, runner } = await startTwoForeign(() => observed);
    await runner.runOnce();
    const opening = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    observed = [observed[0]!, { ...observed[1]!, fingerprint: fingerprint("c") }, observed[2]!];
    await makeNextRunDue(1);
    await runner.runOnce();
    const changed = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    expect(changed!.generation).toBe(opening!.generation + 1);
    expect(changed!.fingerprint).not.toBe(opening!.fingerprint);
    expect(
      await services.connectionHealth.listOpenReasonGenerations({
        accountId: "account-1",
        connectionId: "connection-1",
      }),
    ).toMatchObject([{ reasonCode: "drift", generation: 2, fingerprint: changed!.fingerprint }]);
  });

  it("S6 bounded overflow never truncates generation identity or original structural membership", async () => {
    const matching = [
      state("external-repairable", "7", 1_000, 2, fingerprint("1")),
      state("external-foreign", "7", 1_000, 2, fingerprint("2")),
      twoForeign()[2]!,
    ];
    let observed = [
      ...matching,
      ...Array.from({ length: 101 }, (_, index) =>
        state(`synthetic-unmapped-${index}`, "foreign", 1_200, 1, fingerprint("a")),
      ),
    ];
    const { services, runner } = await startTwoForeign(() => observed);
    await runner.runOnce();
    const opening = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    expect(opening).toMatchObject({ affectedListingCount: 100, hasMore: 1 });
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1", limit: 1 }),
    ).toMatchObject({ fingerprint: opening!.fingerprint, affectedListingCount: 1, hasMore: 1 });
    observed = [...matching, observed[3]!];
    await makeNextRunDue(1);
    await runner.runOnce();
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toMatchObject({
      generation: opening!.generation,
      fingerprint: opening!.fingerprint,
      affectedListingCount: 1,
      hasMore: 0,
      resolution: null,
    });
    const retained = (
      await pools.channels.query<{ count: number }>(
        "SELECT jsonb_array_length(drift_generation->'members') AS count FROM channel_reconciliation_state",
      )
    ).rows;
    expect(retained).toEqual([{ count: 101 }]);
    observed = matching;
    await makeNextRunDue(2);
    await runner.runOnce();
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toMatchObject({ generation: opening!.generation, resolution: "recovered-automatically" });
  });

  it("S6 repush in mixed original membership resolves automatically only on a complete clean confirmation", async () => {
    let observed = twoForeign();
    const { services, runner } = await startTwoForeign(() => observed);
    await runner.runOnce();
    await services.reconciliation.repushChannelListing(
      {
        connectionId: "connection-1",
        channelListingId: "channel-repairable",
        expectedDecisionRevision: 0,
        operationId: "synthetic-s6-repush",
      },
      accountScopedWorkerContext("account-1"),
    );
    await accept(services, "foreign", "b", "2");
    await makeNextRunDue(1);
    await runner.runOnce();
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toMatchObject({ resolution: null });
    expect(
      (await pools.channels.query("SELECT status,attempt_count FROM channel_outbound_operations")).rows,
    ).toMatchObject([{ status: "pending", attempt_count: 0 }]);
    observed = [state("external-repairable", "7", 1_000, 2, fingerprint("1")), observed[1]!, observed[2]!];
    await makeNextRunDue(2);
    await runner.runOnce();
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toMatchObject({ resolution: "recovered-automatically" });
    expect((await pools.channels.query("SELECT resolution_reason FROM channel_connection_attention")).rows).toEqual([
      { resolution_reason: "recovered-automatically" },
    ]);
  });

  it("S6 unknown confirmation never settles accepted members or closes health", async () => {
    let unknown = false;
    const { services, runner } = await startTwoForeign(() => {
      if (unknown) throw new Error("Synthetic incomplete provider state.");
      return twoForeign();
    });
    await runner.runOnce();
    const opening = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    await accept(services, "repairable", "a", "1");
    await accept(services, "foreign", "b", "2");
    unknown = true;
    await makeNextRunDue(1);
    await runner.runOnce();
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toEqual(opening);
    expect(
      await services.connectionHealth.listOpenReasonGenerations({
        connectionId: "connection-1",
        accountId: "account-1",
      }),
    ).toMatchObject([{ reasonCode: "drift", fingerprint: opening!.fingerprint, state: "degraded" }]);
    unknown = false;
    await makeNextRunDue(2);
    await runner.runOnce();
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toMatchObject({ fingerprint: opening!.fingerprint, resolution: "handled-on-channel" });
  });

  it("S6 stale producer completion cannot replace retained membership or publish a terminal", async () => {
    let conflict = false;
    const { services, runner } = await startTwoForeign(async () => {
      if (conflict)
        await pools.channels.query(
          "UPDATE channel_reconciliation_state SET revision=revision+1 WHERE connection_id='connection-1' AND generation=2 AND state='running'",
        );
      return twoForeign();
    });
    await runner.runOnce();
    const opening = await services.reconciliation.readChannelDriftAttentionContribution({
      connectionId: "connection-1",
    });
    conflict = true;
    await makeNextRunDue(1);
    expect(await runner.runOnce()).toMatchObject({ processed: 0 });
    expect(
      await services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).toEqual(opening);
    expect(
      (await pools.channels.query("SELECT count(*)::int AS count FROM channel_reconciliation_health_observations"))
        .rows,
    ).toEqual([{ count: 1 }]);
  });

  it("S6 a failed live source degrades only channel-action in the real shared collector", async () => {
    const { runner } = await startTwoForeign();
    await runner.runOnce();
    let reads = 0;
    const source = createChannelActionAttentionSourceFromReadModel({
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        reads++;
        if (sql.includes("AS affected_count")) throw new Error("Synthetic retained contribution read unavailable.");
        return pools.channels.query<Row>(sql, params);
      },
    });
    const result = await aggregateSellerAttentionQueue([source, { id: "listing-action", load: async () => [] }], {
      accountId: "account-1",
      now: new Date().toISOString(),
    });
    expect(reads).toBe(4);
    expect(result).toMatchObject({
      degraded: true,
      items: [],
      sources: [
        { id: "channel-action", status: "unavailable", reason: "channel-action-unavailable" },
        { id: "listing-action", status: "available" },
      ],
    });
  });

  it("S8 actual default health hold keeps outbound pending and inbound Inventory recording admitted", async () => {
    const read = vi.fn(() => [state("external-repairable", "6", 900, 1, fingerprint("a")), ...twoForeign().slice(1)]);
    const { services, runner } = await startTwoForeign(read);
    for (let generation = 0; generation < 3; generation++) {
      if (generation) await makeNextRunDue(generation);
      await runner.runOnce();
    }
    expect(
      await services.connectionHealth.readConnectionHealth({ accountId: "account-1", connectionId: "connection-1" }),
    ).toMatchObject({ systemPaused: true, verifiedInboundSaleAllowed: true });
    expect(
      await services.outboundSync.processNextInlineOperation({
        registry: syntheticRegistry(),
        claimOwnerId: "synthetic-s6-held-worker",
      }),
    ).toBe(0);
    await makeNextRunDue(3);
    await runner.runOnce();
    expect(read).toHaveBeenCalledTimes(3);
    expect((await pools.channels.query("SELECT state FROM channel_reconciliation_state")).rows).toEqual([
      { state: "held" },
    ]);
    expect((await pools.channels.query("SELECT status,attempt_count FROM channel_outbound_operations")).rows).toEqual([
      { status: "pending", attempt_count: 0 },
    ]);
    expect(
      await createPlatformChannelSaleRecorder(pools.inventory)(saleCommand("synthetic-real-health-held-inbound")),
    ).toMatchObject({ status: "committed" });
  });
});

function twoForeign(): readonly ChannelStateLineV1[] {
  return [
    state("external-repairable", "foreign-a", 1_200, 1, fingerprint("a")),
    state("external-foreign", "foreign-b", 1_200, 1, fingerprint("b")),
    state("external-structural", "7", 1_000, 2, fingerprint("3")),
  ];
}
async function startTwoForeign(
  readObserved: () => readonly ChannelStateLineV1[] | Promise<readonly ChannelStateLineV1[]> = twoForeign,
) {
  await seedInventoryItem(pools.inventory);
  await seedChannelDrift(pools.channels);
  const services = channelsModule.createServices(pools.channels, {
    channelSaleRecorder: createPlatformChannelSaleRecorder(pools.inventory),
  });
  const [runner] = createChannelsReconciliationRunners({
    services,
    controlPlane: createPostgresPlatformControlPlane(pools.control),
    registry: syntheticRegistry(readObserved),
  });
  return { services, runner: runner! };
}
async function accept(
  services: ReturnType<typeof channelsModule.createServices>,
  listing: string,
  observed: string,
  expected: string,
) {
  return services.reconciliation.acceptChannelDrift(
    {
      connectionId: "connection-1",
      channelListingId: `channel-${listing}`,
      observedFingerprint: fingerprint(observed),
      expectedMaterialFingerprint: fingerprint(expected),
      expectedDecisionRevision: 0,
      operationId: `synthetic-s6-accept-${listing}`,
    },
    accountScopedWorkerContext("account-1"),
  );
}

async function makeNextRunDue(generation: number) {
  await pools.channels.query(
    "UPDATE channel_reconciliation_state SET next_due_at=now()-interval '1 minute' WHERE connection_id='connection-1' AND generation=$1",
    [generation],
  );
  await pools.control.query(
    "UPDATE platform_scheduled_runners SET next_run_at=now()-interval '1 minute' WHERE runner_name='channels-drift-reconciliation'",
  );
}

const systemContext: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_identity_system" as never, forAccountId: "acc_identity_system" as never },
};

async function proveInboundIgnoresEveryHoldCombination(recorder: RecordExternalChannelSale) {
  for (let mask = 0; mask < 8; mask += 1) {
    const sellerHeld = Boolean(mask & 1);
    const healthHeld = Boolean(mask & 2);
    const operatorHeld = Boolean(mask & 4);
    await expect(
      recorder(saleCommand(`hold-${Number(sellerHeld)}${Number(healthHeld)}${Number(operatorHeld)}`)),
    ).resolves.toMatchObject({ status: "committed" });
  }
}

function saleCommand(line: string): Parameters<RecordExternalChannelSale>[0] {
  return {
    accountId: "account-1",
    inventoryItemId: "item-repairable",
    storageLocationId: "location-1",
    saleKey: {
      version: "v1",
      providerKey: "synthetic-reconciliation",
      sellerEnvironmentLineage: "sandbox-worker-test",
      orderLineIdentity: `order:${line}`,
    },
    requestedQuantity: 1,
    connectionAuditReference: "connection-1",
  };
}

async function seedInventoryItem(db: PgTransactionalPool) {
  await createPostgresEventStore({ pool: db }).appendToStream({
    streamId: "inventory.item-item-repairable",
    expectedVersion: "no_stream",
    context: accountScopedWorkerContext("account-1"),
    events: [
      {
        eventType: "inventory.item.created",
        payload: {
          itemId: "item-repairable",
          accountId: "account-1",
          catalogItemId: "catalog-repairable",
          productId: "catalog-repairable::raw",
          selectedOptions: [],
          gradedCard: null,
          storageLocationId: "location-1",
          totalQuantity: 20,
          acquisitionCostAmount: "10.00",
          acquisitionCostCurrencyCode: "USD",
          acquisitionOccurrence: { kind: "unknown" },
        },
      },
    ],
  });
}

async function seedChannelDrift(db: PgTransactionalPool) {
  await createPostgresEventStore({ pool: db }).appendToStream({
    streamId: "channels.connection-connection-1",
    expectedVersion: "no_stream",
    context: accountScopedWorkerContext("account-1"),
    events: [
      {
        eventType: "channels.connection.connected",
        payload: {
          connectionId: "connection-1",
          accountId: "account-1",
          providerKey: "synthetic-reconciliation",
          environment: "sandbox",
          createdAt: new Date().toISOString(),
        },
      },
      {
        eventType: "channels.connection.activated",
        payload: {
          connectionId: "connection-1",
          credentialReference: null,
          bindings: [{ storageLocationId: "location-1", revision: 1 }],
        },
      },
    ],
  });
  await db.query(
    `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
     VALUES ('connection-1','account-1','synthetic-reconciliation','sandbox','active',now(),now(),
       '[{"storageLocationId":"location-1","revision":1}]'::jsonb,now(),2)`,
  );
  await db.query(
    `INSERT INTO channels_connection_facts
       (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     VALUES ('connection-1','account-1','synthetic-reconciliation','sandbox','active',now(),2)`,
  );
  const eventStore = createPostgresEventStore({ pool: db });
  for (const [name, material] of [
    ["repairable", "1"],
    ["foreign", "2"],
    ["structural", "3"],
  ] as const) {
    const channelListingId = `channel-${name}`;
    const listingId = `listing-${name}`;
    const itemId = name === "repairable" ? "item-repairable" : `item-${name}`;
    const desiredStateHash = fingerprint(material);
    const draft = {
      channelListingId,
      listingRevision: 7,
      title: name,
      description: "synthetic scheduled-runner drift",
      categoryKey: "category",
      conditionKey: "condition",
      price: { amountMinor: 1_000, currency: "USD" },
      quantity: 2,
      attributes: [],
    };
    await eventStore.appendToStream({
      streamId: `channels.channel-listing-${channelListingId}`,
      expectedVersion: "no_stream",
      context: accountScopedWorkerContext("account-1"),
      events: [
        {
          eventType: "channels.channel-listing.desired-state-changed",
          payload: {
            connectionId: "connection-1",
            channelListingId,
            listingId,
            listingRevision: 7,
            desiredStateSequence: 1,
            desiredStateHash,
            intent: "update",
            draft,
          },
        },
      ],
    });
    await db.query(
      `INSERT INTO channels_listing_publication_facts
         (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
          selected_options,selected_option_key,listing_status,updated_at,listing_stream_version)
       VALUES ($1,'account-1',$2,$3,'10.00','USD',2,'[]'::jsonb,'key','active',now(),1)`,
      [listingId, itemId, `catalog-${name}`],
    );
    await db.query(
      `INSERT INTO channels_inventory_item_facts
         (item_id,account_id,catalog_item_id,storage_location_id,total_quantity,updated_at,item_stream_version)
       VALUES ($1,'account-1',$2,'location-1',20,now(),1)`,
      [itemId, `catalog-${name}`],
    );
    await db.query(
      `INSERT INTO channels_channel_listing_links
         (connection_id,listing_id,channel_listing_id,external_listing_id,external_offer_id,
          last_desired_state_sequence,last_desired_listing_revision,last_desired_state_hash,last_desired_intent,
          last_desired_payload,last_pushed_listing_revision,publish_state,updated_at,last_stream_version)
       VALUES ('connection-1',$1,$2,$3,NULL,1,7,$4,'update',$5::jsonb,6,'published',now(),1)`,
      [
        listingId,
        channelListingId,
        `external-${name}`,
        desiredStateHash,
        JSON.stringify({
          connectionId: "connection-1",
          channelListingId,
          listingId,
          listingRevision: 7,
          desiredStateSequence: 1,
          desiredStateHash,
          intent: "update",
          draft,
        }),
      ],
    );
  }
}

function syntheticRegistry(
  readObserved: () => readonly ChannelStateLineV1[] | Promise<readonly ChannelStateLineV1[]> = () => [
    state("external-repairable", "6", 900, 1, fingerprint("a")),
    state("external-foreign", "foreign", 1_200, 1, fingerprint("b")),
  ],
) {
  return createChannelProviderRegistry([
    {
      identity: { providerKey: "synthetic-reconciliation", environment: "sandbox" },
      setup: {
        providerKey: "synthetic-reconciliation",
        environment: "sandbox",
        requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
      },
      publication: {
        execution: "inline",
        publishListing: providerWrite,
        updatePriceQuantity: providerWrite,
        delistListing: providerWrite,
        fetchChannelState: async () => {
          const items = await readObserved();
          return { kind: "complete", items, collectedCount: items.length, authorityTotal: items.length, pageCount: 1 };
        },
        fetchSales: async () => ({
          kind: "complete",
          lines: [
            {
              saleKey: {
                version: "v1",
                providerKey: "synthetic-reconciliation",
                sellerEnvironmentLineage: "sandbox-worker-test",
                orderLineIdentity: "order:seeded-gap",
              },
              externalListingId: "external-repairable",
              externalOfferId: null,
              requestedQuantity: 1,
              unitPriceAmount: "10.00",
              currencyCode: "USD",
            },
          ],
          collectedCount: 1,
          authorityTotal: 1,
          pageCount: 1,
        }),
      },
    } satisfies ChannelProviderDescriptor,
  ]);
}

function state(
  externalListingId: string,
  revision: string,
  amountMinor: number,
  quantity: number,
  materialFingerprint: string,
): ChannelStateLineV1 {
  return {
    externalListingId,
    externalOfferId: null,
    revision,
    price: { amountMinor, currency: "USD" },
    quantity,
    fingerprint: materialFingerprint,
  };
}

function fingerprint(character: string): string {
  return character.repeat(64);
}
