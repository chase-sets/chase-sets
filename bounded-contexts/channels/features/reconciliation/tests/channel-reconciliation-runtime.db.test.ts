import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPgPool,
  createPostgresAggregateSnapshotStore,
  createPostgresEventStore,
  withPgTransaction,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";
import { module as channelsModule } from "../../../index";
import { module as inventoryModule } from "@chase-sets/inventory";
import { createOutboundSyncRuntime } from "../../outbound-sync/api/runtime";
import { buildChannelListingStateProjectionHandlers } from "../../listing-composition/read-model/state-projection";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import type { ChannelProviderDescriptor, ChannelStateLineV1 } from "../../publication-port/domain/contracts";
import { createChannelReconciliationRuntime } from "../api/runtime";
import type { ChannelReconciliationRuntimeDependencies } from "../domain/contracts";
import { CHANNEL_RECONCILIATION_POLICY_FALLBACK } from "../domain/policy";
import { resolveChannelExternalSaleTarget } from "../read-model/sale-target";
import { readExpectedReconciliationListings } from "../read-model/source";
import { channelReconciliationSchemaSql, retainedDriftGenerationExpansion } from "../read-model/schema";
import { channelReconciliationSchemaSql as predecessorSchemaSql } from "./fixtures/pre-generation-schema.test-data";
import { readChannelDriftAttentionContribution } from "../read-model/queries";
import { createChannelActionAttentionSourceFromReadModel } from "../../connection-attention/read-model/attention-source";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels" | "inventory", PgTransactionalPool>>;
const rollback = Symbol("rollback test transaction");
const context: EventStoreContext = {
  tenantId: "tnt_reconciliation_test" as never,
  audit: { performedByUserId: "usr_reconciliation_test" as never, forAccountId: "account-1" as never },
};

describeDb("Channel Reconciliation guarded production path", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels", "inventory"],
      "channel_reconciliation",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it.each(
    Array.from({ length: 12 }, (_, mask) => ({
      seller: Boolean(mask & 1),
      health: Boolean(mask & 2),
      operator: mask >= 8 ? "unavailable" : mask & 4 ? "held" : "released",
    })).flatMap((holds) => (["inline", "claimed"] as const).map((execution) => ({ ...holds, execution }))),
  )("S5 command enqueues $execution under seller=$seller health=$health operator=$operator", async (holds) => {
    await seedConnectionAndListings(pools.channels);
    let released = false;
    let observed = matchingItems({ foreignRevision: "foreign", foreignFingerprint: fingerprint("b") });
    const registry = inlineRegistry(() => observed);
    const setup = createRuntime(registry);
    const run = { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null } as const;
    await setup.reconcileConnection(run, context);
    const contribution = await setup.readChannelDriftAttentionContribution({ connectionId: "connection-1" });
    if (holds.seller)
      await pools.channels.query("UPDATE channel_connections SET status='paused' WHERE connection_id='connection-1'");
    const additionalHold = async () => ({
      held: !released && (holds.health || holds.operator !== "released"),
      sources: released
        ? []
        : [
            ...(holds.health ? ["health" as const] : []),
            ...(holds.operator !== "released" ? ["operator-kill" as const] : []),
          ],
    });
    const outbound = createOutboundSyncRuntime(
      { db: pools.channels, readAdditionalOutboundHold: additionalHold, recordOutcome: async () => "applied" },
      { assertDelistDirective: () => undefined },
    );
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: outbound,
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context),
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () =>
        !released && holds.operator === "unavailable"
          ? null
          : {
              heldProviderKeys: !released && holds.operator === "held" ? ["inline-provider"] : [],
              heldConnectionIds: [],
            },
      readHealthHold: async () => !released && holds.health,
    });
    const accepted = await runtime.acceptChannelDrift(
      {
        connectionId: "connection-1",
        channelListingId: "channel-foreign",
        expectedDecisionRevision: 0,
        operationId: "s5-accept",
        observedFingerprint: fingerprint("b"),
        expectedMaterialFingerprint: fingerprint("2"),
      },
      context,
    );
    expect(accepted).toMatchObject({ revision: 1, accepted: { observedFingerprint: fingerprint("b") } });
    const command = {
      connectionId: "connection-1",
      channelListingId: "channel-foreign",
      expectedDecisionRevision: 1,
      operationId: "s5-repush",
    };
    await runtime.repushChannelListing(command, context);
    const queued = await pools.channels.query(
      "SELECT operation_id,status,attempt_count FROM channel_outbound_operations WHERE operation_origin='repush'",
    );
    expect(queued.rows).toEqual([{ operation_id: expect.any(String), status: "pending", attempt_count: 0 }]);
    await expect(runtime.repushChannelListing(command, context)).resolves.toMatchObject({
      revision: 3,
      accepted: null,
      repushRequested: false,
    });
    expect(await runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" })).toEqual(contribution);
    const held = holds.seller || holds.health || holds.operator !== "released";
    if (held) expect(await runtime.reconcileConnection(run, context)).toMatchObject({ state: "held" });
    const providerCall = vi.fn(async () => ({ kind: "succeeded" as const, externalListingId: "external-foreign" }));
    const executionRegistry = createChannelProviderRegistry([
      descriptor("inline-provider", {
        execution: "inline",
        publishListing: providerCall,
        updatePriceQuantity: providerCall,
        delistListing: providerCall,
        fetchChannelState: async () => ({ kind: "bounded-unknown", reason: "source-error" }),
        fetchSales: async () => ({ kind: "bounded-unknown", reason: "source-error" }),
      }),
    ]);
    if (holds.execution === "claimed") {
      const reserve = () =>
        outbound.reserveClaimedOutboundOperations({
          registry: createChannelProviderRegistry([descriptor("inline-provider", { execution: "claimed" })]),
          connectionId: "connection-1",
          claimant: { claimantKind: "manual", claimantId: "synthetic-s5-claimed" },
          maxOperations: 1,
          leaseMs: 60_000,
        });
      if (holds.seller) await expect(reserve()).rejects.toMatchObject({ code: "connection-not-active" });
      else expect((await reserve()) === null).toBe(held);
      if (held)
        expect(
          (
            await pools.channels.query(
              "SELECT operation_id,status,attempt_count FROM channel_outbound_operations WHERE operation_origin='repush'",
            )
          ).rows,
        ).toEqual(queued.rows);
      released = true;
      await pools.channels.query("UPDATE channel_connections SET status='active' WHERE connection_id='connection-1'");
      if (held) expect(await reserve()).not.toBeNull();
      expect(await reserve()).toBeNull();
      expect(
        (
          await pools.channels.query(
            "SELECT operation_id,status,attempt_count FROM channel_outbound_operations WHERE operation_origin='repush'",
          )
        ).rows,
      ).toEqual([{ operation_id: queued.rows[0]!.operation_id, status: "in-flight", attempt_count: 1 }]);
      expect(providerCall).not.toHaveBeenCalled();
      return;
    }
    expect(await outbound.processNextInlineOperation({ registry: executionRegistry, claimOwnerId: "s5-inline" })).toBe(
      held ? 0 : 1,
    );
    expect(providerCall).toHaveBeenCalledTimes(held ? 0 : 1);
    if (held)
      expect(
        (
          await pools.channels.query(
            "SELECT operation_id,status,attempt_count FROM channel_outbound_operations WHERE operation_origin='repush'",
          )
        ).rows,
      ).toEqual(queued.rows);
    released = true;
    await pools.channels.query("UPDATE channel_connections SET status='active' WHERE connection_id='connection-1'");
    expect(await outbound.processNextInlineOperation({ registry: executionRegistry, claimOwnerId: "s5-inline" })).toBe(
      held ? 1 : 0,
    );
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(await outbound.processNextInlineOperation({ registry: executionRegistry, claimOwnerId: "s5-inline" })).toBe(
      0,
    );
    observed = matchingItems();
    expect(await runtime.reconcileConnection(run, context)).toMatchObject({ clean: true });
    expect(await runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" })).toMatchObject({
      generation: contribution!.generation,
      fingerprint: contribution!.fingerprint,
      resolution: "recovered-automatically",
    });
  });

  it("S5 production composition commits the queue and durable decision before acknowledgement", async () => {
    const { command } = await s5Setup();
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context),
    });
    expect(await services.reconciliation.repushChannelListing(command, context)).toMatchObject({
      revision: 2,
      repushRequested: false,
    });
    expect((await pools.channels.query("SELECT status,attempt_count FROM channel_outbound_operations")).rows).toEqual([
      { status: "pending", attempt_count: 0 },
    ]);
    await expect(services.reconciliation.repushChannelListing(command, context)).resolves.toMatchObject({
      revision: 2,
    });
    expect((await decisionEvents()).map((event) => event.eventType)).toEqual([
      "channels.channel-drift.repush-requested",
      "channels.channel-drift.repush-enqueued",
    ]);
  });

  it.each(["before-enqueue", "after-enqueue", "after-consumption"] as const)(
    "S5 retained interruption %s rolls back atomically then retries once",
    async (stage) => {
      const { command, outbound } = await s5Setup();
      const eventStore = createPostgresEventStore({ pool: pools.channels });
      const interrupted = new Error("synthetic interruption");
      const runtime = s5Runtime({
        outboundSync: {
          ...outbound,
          enqueueRepush: async (input, db) => {
            if (stage === "before-enqueue") throw interrupted;
            const result = await outbound.enqueueRepush(input, db);
            if (stage === "after-enqueue") throw interrupted;
            return result;
          },
        },
        eventStore: {
          readStream: eventStore.readStream.bind(eventStore),
          appendToStreamInTransaction: async (db, input) => {
            const result = await eventStore.appendToStreamInTransaction(db, input);
            if (
              stage === "after-consumption" &&
              input.events.some((event) => event.eventType === "channels.channel-drift.repush-enqueued")
            )
              throw interrupted;
            return result;
          },
        },
      });
      await expect(runtime.repushChannelListing(command, context)).rejects.toThrow(interrupted);
      expect(await decisionEvents()).toEqual([]);
      expect((await pools.channels.query("SELECT operation_id FROM channel_outbound_operations")).rows).toEqual([]);
      expect((await pools.channels.query("SELECT operation_id FROM channel_drift_decision_operations")).rows).toEqual(
        [],
      );
      const restarted = s5Runtime({ outboundSync: outbound });
      await expect(restarted.repushChannelListing(command, context)).resolves.toMatchObject({
        revision: 2,
        repushRequested: false,
      });
      await expect(s5Runtime({ outboundSync: outbound }).repushChannelListing(command, context)).resolves.toMatchObject(
        { revision: 2 },
      );
      expect(await decisionEvents()).toHaveLength(2);
      expect((await pools.channels.query("SELECT status,attempt_count FROM channel_outbound_operations")).rows).toEqual(
        [{ status: "pending", attempt_count: 0 }],
      );
    },
  );

  it.each(["null", "identity", "basis", "failed"] as const)(
    "S5 retained %s enqueue preserves the matching request and same-operation retry consumes once",
    async (mode) => {
      const { command, outbound } = await s5Setup();
      const mismatched = s5Runtime({
        outboundSync: {
          ...outbound,
          enqueueRepush: async (input, db) => {
            if (mode === "null") return null;
            const operation = (await outbound.enqueueRepush(input, db))!;
            return mode === "identity"
              ? { ...operation, operationId: "cop_" + "0".repeat(40) }
              : mode === "basis"
                ? { ...operation, sourceDesiredStateHash: fingerprint("f") }
                : { ...operation, status: "failed" };
          },
        },
      });
      await expect(mismatched.repushChannelListing(command, context)).resolves.toMatchObject({
        revision: 1,
        repushRequested: true,
      });
      expect(await decisionEvents()).toHaveLength(1);
      const runtime = s5Runtime({ outboundSync: outbound });
      await expect(runtime.repushChannelListing(command, context)).resolves.toMatchObject({
        revision: 2,
        repushRequested: false,
      });
      await expect(runtime.repushChannelListing(command, context)).resolves.toMatchObject({ revision: 2 });
      expect(await decisionEvents()).toHaveLength(2);
      expect((await pools.channels.query("SELECT status,attempt_count FROM channel_outbound_operations")).rows).toEqual(
        [{ status: "pending", attempt_count: 0 }],
      );
    },
  );

  it("S5 same-operation concurrency and response loss replay one durable queue operation", async () => {
    const { command, outbound } = await s5Setup();
    const runtime = s5Runtime({ outboundSync: outbound });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => runtime.repushChannelListing(command, context)),
    );
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "fulfilled") expect(result.value).toMatchObject({ revision: 2, repushRequested: false });
      else
        expect(result.reason).toMatchObject({
          message: expect.stringMatching(/(projection|receipt) does not match its event history/),
        });
      await expect(s5Runtime({ outboundSync: outbound }).repushChannelListing(command, context)).resolves.toMatchObject(
        { revision: 2, repushRequested: false },
      );
    }
    expect(await decisionEvents()).toHaveLength(2);
    expect((await pools.channels.query("SELECT operation_id FROM channel_outbound_operations")).rows).toHaveLength(1);
  });

  it("S5 competing identities reject stale decisions without replacing held work", async () => {
    const { command, outbound } = await s5Setup();
    const runtime = s5Runtime({ outboundSync: outbound });
    const results = await Promise.allSettled(
      [command, { ...command, operationId: "s5-other" }].map((input) => runtime.repushChannelListing(input, context)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { message: expect.stringMatching(/revision is stale|projection does not match its event history/) } },
    ]);
    const retained = (await pools.channels.query("SELECT * FROM channel_outbound_operations")).rows;
    await expect(
      runtime.repushChannelListing({ ...command, operationId: "s5-next", expectedDecisionRevision: 2 }, context),
    ).resolves.toMatchObject({ revision: 3, repushRequested: true });
    expect((await pools.channels.query("SELECT * FROM channel_outbound_operations")).rows).toEqual(retained);
    await expect(
      runtime.repushChannelListing({ ...command, operationId: "s5-next", expectedDecisionRevision: 2 }, context),
    ).resolves.toMatchObject({ revision: 3, repushRequested: true });
    expect(await decisionEvents()).toHaveLength(3);
  });

  it("S5 account fences precede fresh and replay history disclosure or enqueue", async () => {
    const { command, outbound } = await s5Setup();
    const enqueue = vi.spyOn(outbound, "enqueueRepush");
    const runtime = s5Runtime({ outboundSync: outbound });
    const foreignContext = { ...context, audit: { ...context.audit, forAccountId: "foreign-account" as never } };
    await expect(runtime.repushChannelListing(command, foreignContext)).rejects.toThrow("account");
    expect(enqueue).not.toHaveBeenCalled();
    await runtime.repushChannelListing(command, context);
    enqueue.mockClear();
    await expect(runtime.repushChannelListing(command, foreignContext)).rejects.toThrow("account");
    expect(enqueue).not.toHaveBeenCalled();
    expect(await decisionEvents()).toHaveLength(2);
  });

  it("S5 lagging projection cannot reauthor a committed decision", async () => {
    const { command, outbound } = await s5Setup();
    const runtime = s5Runtime({ outboundSync: outbound });
    await runtime.repushChannelListing(command, context);
    const retained = (await pools.channels.query("SELECT * FROM channel_outbound_operations")).rows;
    await pools.channels.query(
      "UPDATE channel_drift_decisions SET revision=0,repush_requested=false,last_operation_id=NULL",
    );
    await expect(runtime.repushChannelListing(command, context)).rejects.toThrow("projection does not match");
    await expect(runtime.repushChannelListing({ ...command, operationId: "s5-stale" }, context)).rejects.toThrow(
      "revision is stale",
    );
    expect(await decisionEvents()).toHaveLength(2);
    expect((await pools.channels.query("SELECT * FROM channel_outbound_operations")).rows).toEqual(retained);
  });

  it("S5 command and replay use one pool connection without nested borrowing", async () => {
    const { command } = await s5Setup();
    const database = (await pools.channels.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name;
    const url = new URL(databaseBaseUrl!);
    url.pathname = `/${database}`;
    const single = createPgPool(url.toString(), { max: 1, connectionTimeoutMillis: 1_000 });
    try {
      const outbound = createOutboundSyncRuntime(
        { db: single, readAdditionalOutboundHold: async () => ({ held: true, sources: ["health"] }) },
        { assertDelistDirective: () => undefined },
      );
      const runtime = s5Runtime({
        db: single,
        eventStore: createPostgresEventStore({ pool: single }),
        outboundSync: outbound,
      });
      await expect(runtime.repushChannelListing(command, context)).resolves.toMatchObject({
        revision: 2,
        repushRequested: false,
      });
      await expect(runtime.repushChannelListing(command, context)).resolves.toMatchObject({
        revision: 2,
        repushRequested: false,
      });
      expect((await single.query("SELECT status,attempt_count FROM channel_outbound_operations")).rows).toEqual([
        { status: "pending", attempt_count: 0 },
      ]);
    } finally {
      await closeMultiContextTestPools({ channels: single });
    }
  });

  it.each([
    "completion-only",
    "wrong-request",
    "repeated-request",
    "repeated-completion",
    "wrong-target",
    "wrong-revision",
    "unexpected",
  ] as const)("S5 poison %s is rejected from authoritative history", async (mode) => {
    const { command, outbound } = await s5Setup();
    const requested = { eventType: "channels.channel-drift.repush-requested", payload: { ...command } };
    const completed = {
      eventType: "channels.channel-drift.repush-enqueued",
      payload: { ...command, expectedDecisionRevision: 1 },
    };
    const events =
      mode === "completion-only"
        ? [{ ...completed, payload: { ...command } }]
        : mode === "wrong-request"
          ? [requested, { ...completed, payload: { ...completed.payload, operationId: "wrong-operation" } }]
          : mode === "repeated-request"
            ? [requested, { ...requested, payload: { ...command, expectedDecisionRevision: 1 } }]
            : mode === "repeated-completion"
              ? [requested, completed, { ...completed, payload: { ...completed.payload, expectedDecisionRevision: 2 } }]
              : mode === "wrong-target"
                ? [{ ...requested, payload: { ...command, channelListingId: "wrong-listing" } }]
                : mode === "wrong-revision"
                  ? [{ ...requested, payload: { ...command, expectedDecisionRevision: 5 } }]
                  : [{ eventType: "channels.channel-drift.poisoned", payload: { ...command } }];
    await createPostgresEventStore({ pool: pools.channels }).appendToStream({
      streamId: "channels.channel-drift-decision-connection-1-channel-foreign",
      expectedVersion: "no_stream",
      context,
      events,
    });
    const before = await decisionEvents();
    await expect(s5Runtime({ outboundSync: outbound }).repushChannelListing(command, context)).rejects.toThrow(
      "event history",
    );
    expect(await decisionEvents()).toEqual(before);
    expect((await pools.channels.query("SELECT operation_id FROM channel_outbound_operations")).rows).toEqual([]);
  });

  it("S5 replay does not consume a newer request or accept a forged command receipt", async () => {
    const { command, outbound } = await s5Setup();
    const runtime = s5Runtime({ outboundSync: outbound });
    await runtime.repushChannelListing(command, context);
    const later = { ...command, operationId: "synthetic-s5-later", expectedDecisionRevision: 2 };
    await runtime.repushChannelListing(later, context);
    await expect(runtime.repushChannelListing(command, context)).resolves.toMatchObject({
      revision: 3,
      operationId: later.operationId,
      repushRequested: true,
    });
    expect(await decisionEvents()).toHaveLength(3);
    const forged = { ...command, expectedDecisionRevision: 99 };
    await pools.channels.query(
      "UPDATE channel_drift_decision_operations SET command_fingerprint=$2 WHERE operation_id=$1",
      [
        command.operationId,
        createHash("sha256")
          .update(JSON.stringify({ kind: "repush", ...forged }))
          .digest("hex"),
      ],
    );
    await expect(runtime.repushChannelListing(forged, context)).rejects.toThrow(
      "receipt does not match its event history",
    );
    expect(await decisionEvents()).toHaveLength(3);
  });

  it("S5 outbound replay serializes same identities and rejects conflicting desired provenance", async () => {
    const { outbound } = await s5Setup();
    const expected = await readExpectedReconciliationListings(pools.channels, {
      connectionId: "connection-1",
      channelListingId: "channel-foreign",
      limit: 1,
    });
    const input = { ...expected.items[0]!.desired, repushOperationId: "synthetic-s5-outbound-race" };
    const operations = await Promise.all([outbound.enqueueRepush(input), outbound.enqueueRepush(input)]);
    expect(operations[0]).toEqual(operations[1]);
    await expect(outbound.enqueueRepush({ ...input, desiredStateHash: fingerprint("f") })).rejects.toMatchObject({
      code: "stale-fence",
    });
    await expect(
      outbound.enqueueRepush({ ...input, envelope: { ...input.envelope, sourceEventId: "synthetic-wrong-event" } }),
    ).rejects.toMatchObject({ code: "stale-fence" });
    expect((await pools.channels.query("SELECT operation_id FROM channel_outbound_operations")).rows).toHaveLength(1);
  });

  it("S6 retained old schema requires the owning migration and survives repeated real boot", async () => {
    await resetMultiContextTestSchemas({ channels: pools.channels });
    const predecessor = {
      ...channelsModule,
      schemaSql: channelsModule.schemaSql.replace(channelReconciliationSchemaSql, () => predecessorSchemaSql),
      schemaMigrations: channelsModule.schemaMigrations!.filter(
        (migration) => migration.migrationId !== "20260914_channels_reconciliation_drift_generation",
      ),
    };
    await bootstrapContextDatabase(predecessor, pools.channels);
    await seedConnectionAndListings(pools.channels);
    await pools.channels.query(`INSERT INTO channel_reconciliation_state
      (connection_id,account_id,provider_key,environment,state,generation,revision,run_fingerprint,
       cadence_policy_revision,next_due_at,last_clean_run_at,counts,updated_at)
      VALUES ('connection-1','account-1','inline-provider','sandbox','idle',0,1,NULL,0,now(),NULL,
        '{"listingsReconciled":0,"inSync":0,"repairable":0,"foreignEdit":0,"structural":0,"sourceUnavailable":0,"repairsEnqueued":0,"repairsSucceeded":0,"missedSaleGaps":0}',now())`);
    const retainedRun = (
      await pools.channels.query(
        "SELECT to_jsonb(run)-'drift_generation' AS retained FROM channel_reconciliation_state AS run",
      )
    ).rows;
    const retainedLinks = (
      await pools.channels.query("SELECT * FROM channels_channel_listing_links ORDER BY channel_listing_id")
    ).rows;
    const omitted = {
      ...channelsModule,
      schemaSql: channelsModule.schemaSql.replace(`${retainedDriftGenerationExpansion};`, ""),
      schemaMigrations: predecessor.schemaMigrations,
    };
    await bootstrapContextDatabase(omitted, pools.channels);
    await expect(
      readChannelDriftAttentionContribution(pools.channels, { connectionId: "connection-1" }),
    ).rejects.toMatchObject({ code: "42703" });
    await bootstrapContextDatabase(channelsModule, pools.channels);
    const ledger = (await pools.channels.query("SELECT * FROM bounded_context_schema_migrations ORDER BY migration_id"))
      .rows;
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await readChannelDriftAttentionContribution(pools.channels, { connectionId: "connection-1" })).toBeNull();
    expect(
      (await pools.channels.query("SELECT * FROM channels_channel_listing_links ORDER BY channel_listing_id")).rows,
    ).toEqual(retainedLinks);
    expect(
      (
        await pools.channels.query(
          "SELECT to_jsonb(run)-'drift_generation' AS retained FROM channel_reconciliation_state AS run",
        )
      ).rows,
    ).toEqual(retainedRun);
    expect(
      (await pools.channels.query("SELECT * FROM bounded_context_schema_migrations ORDER BY migration_id")).rows,
    ).toEqual(ledger);
    expect(
      (
        await pools.channels.query(
          "SELECT count(*)::int AS count FROM bounded_context_schema_migrations WHERE migration_id='20260914_channels_reconciliation_drift_generation'",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    const registry = inlineRegistry(driftItems);
    const runtime = createRuntime(registry);
    expect(
      await runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).toMatchObject({ state: "completed" });
    expect(await runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" })).toMatchObject({
      affectedListingCount: 2,
      resolution: null,
    });
  });

  it("channel-seeded-drift-drill classifies three classes, enqueues only repairable, and retains bounded attention", async () => {
    await seedConnectionAndListings(pools.channels);
    let observed = driftItems();
    const enqueueReconciliationRepair = vi.fn(
      async (input: import("../../outbound-sync/domain/contracts").EnqueueOutboundReconciliationRepair) =>
        pendingOperation(input),
    );
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: {
        enqueueReconciliationRepair,
        enqueueRepush: vi.fn(async () => null),
        readOutboundOperationsByIds: async () => [],
      },
      channelSaleRecorder: vi.fn(async () => ({
        code: "external-channel-sale-history-invalid" as const,
        saleStreamId: "unused",
        reason: "empty-existing-stream" as const,
        eventIndex: null,
      })),
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
    });
    const registry = inlineRegistry(() => observed);
    const result = await runtime.reconcileConnection(
      {
        connectionId: "connection-1",
        registry,
        sourceAttempt: 1,
        healthAuthority: { policyRevision: fingerprint("2"), evaluationGeneration: 3 },
      },
      context,
    );
    expect(result).toMatchObject({
      state: "completed",
      clean: false,
      counts: { listingsReconciled: 3, repairable: 1, foreignEdit: 1, structural: 1, repairsEnqueued: 1 },
    });
    expect(enqueueReconciliationRepair).toHaveBeenCalledTimes(1);
    expect(enqueueReconciliationRepair.mock.calls[0]![0]).toMatchObject({ channelListingId: "channel-repairable" });
    await expect(
      runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({
      connectionId: "connection-1",
      generation: 1,
      affectedListingCount: 2,
      hasMore: 0,
    });
    await expect(runtime.readPendingHealthObservations({ limit: 10 })).resolves.toHaveLength(1);

    const accepted = await runtime.acceptChannelDrift(
      {
        connectionId: "connection-1",
        channelListingId: "channel-foreign",
        observedFingerprint: fingerprint("b"),
        expectedMaterialFingerprint: fingerprint("2"),
        expectedDecisionRevision: 0,
        operationId: "accept-foreign-1",
      },
      context,
    );
    expect(accepted).toMatchObject({ revision: 1, repushRequested: false });
    await expect(
      runtime.acceptChannelDrift(
        {
          connectionId: "connection-1",
          channelListingId: "channel-foreign",
          observedFingerprint: fingerprint("b"),
          expectedMaterialFingerprint: fingerprint("2"),
          expectedDecisionRevision: 0,
          operationId: "accept-foreign-1",
        },
        context,
      ),
    ).resolves.toEqual(accepted);

    observed = [
      state("external-repairable", "7", 1_000, 2, fingerprint("1")),
      state("external-foreign", "foreign", 1_200, 1, fingerprint("b")),
      state("external-structural", "7", 1_000, 2, fingerprint("3")),
    ];
    const retained = await runtime.reconcileConnection(
      {
        connectionId: "connection-1",
        registry,
        sourceAttempt: 1,
        healthAuthority: { policyRevision: fingerprint("2"), evaluationGeneration: 3 },
      },
      context,
    );
    expect(retained).toMatchObject({ clean: true, counts: { inSync: 3, repairsEnqueued: 0 } });
    await expect(
      runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({
      affectedListingCount: 0,
      resolution: "recovered-automatically",
    });
    await expect(
      runtime.readChannelReconciliationMetrics({
        accountId: "account-1",
        connectionId: "connection-1",
        window: { from: "2026-09-12T05:00:00.000Z", to: "2026-09-12T07:00:00.000Z" },
      }),
    ).resolves.toMatchObject({
      runsCompleted: 2,
      counts: { listingsReconciled: 6 },
      lastCleanRunAt: "2026-09-12T06:00:00.000Z",
    });

    observed = [
      state("external-repairable", "6", 900, 1, fingerprint("a")),
      state("external-foreign", "foreign", 1_200, 1, fingerprint("b")),
      state("external-structural", "7", 1_000, 2, fingerprint("3")),
    ];
    await expect(
      runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).resolves.toMatchObject({ clean: false, counts: { repairable: 1, repairsEnqueued: 1 } });
    expect(enqueueReconciliationRepair).toHaveBeenCalledTimes(2);

    await moveExpectedForeignMaterial(pools.channels);
    observed = [
      state("external-repairable", "7", 1_000, 2, fingerprint("1")),
      state("external-foreign", "foreign", 1_200, 1, fingerprint("b")),
      state("external-structural", "7", 1_000, 2, fingerprint("3")),
    ];
    await expect(
      runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).resolves.toMatchObject({ clean: false, counts: { foreignEdit: 1, repairsEnqueued: 0 } });
    expect(enqueueReconciliationRepair).toHaveBeenCalledTimes(2);
  });

  it("channel-reconciliation-generation-interleavings rejects a newer writer before completion", async () => {
    await seedConnectionAndListings(pools.channels);
    let releaseFetch!: () => void;
    let enteredFetch!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFetch = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const registry = inlineRegistry(async () => {
      enteredFetch();
      await release;
      return driftItems();
    });
    const runtime = createRuntime(registry);
    const running = runtime.reconcileConnection(
      { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
      context,
    );
    await entered;
    await pools.channels.query(
      `UPDATE channel_reconciliation_state SET revision=revision+1
       WHERE connection_id='connection-1' AND state='running' AND generation=1`,
    );
    releaseFetch();
    await expect(running).rejects.toThrow("completion lost its generation fence");
    await expect(
      pools.channels.query(
        `SELECT state,generation,revision FROM channel_reconciliation_state WHERE connection_id='connection-1'`,
      ),
    ).resolves.toMatchObject({ rows: [{ state: "running", generation: "1", revision: "3" }] });
  });

  it("enumerates connection lifecycle eligibility without fetching inactive connections", async () => {
    await seedConnectionAndListings(pools.channels);
    const fetch = vi.fn(async () => driftItems());
    const registry = inlineRegistry(fetch);
    const runtime = createRuntime(registry);

    for (const status of ["pending-setup", "disconnected"] as const) {
      await pools.channels.query(`UPDATE channel_connections SET status=$2 WHERE connection_id=$1`, [
        "connection-1",
        status,
      ]);
      await expect(
        runtime.reconcileConnection(
          { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
          context,
        ),
      ).rejects.toThrow("not eligible");
    }
    await pools.channels.query(`UPDATE channel_connections SET status='paused' WHERE connection_id='connection-1'`);
    await expect(
      runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).resolves.toMatchObject({ state: "held", counts: { listingsReconciled: 0 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects poisoned drift-decision history before appending or changing its projection", async () => {
    await seedConnectionAndListings(pools.channels);
    const registry = inlineRegistry(() => driftItems());
    const runtime = createRuntime(registry);
    await runtime.reconcileConnection(
      { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
      context,
    );
    const eventStore = createPostgresEventStore({ pool: pools.channels });
    await eventStore.appendToStream({
      streamId: "channels.channel-drift-decision-connection-1-channel-foreign",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "channels.channel-drift.poisoned", payload: { operationId: "poison" } }],
    });

    await expect(
      runtime.acceptChannelDrift(
        {
          connectionId: "connection-1",
          channelListingId: "channel-foreign",
          observedFingerprint: fingerprint("b"),
          expectedMaterialFingerprint: fingerprint("2"),
          expectedDecisionRevision: 0,
          operationId: "accept-after-poison",
        },
        context,
      ),
    ).rejects.toThrow("unexpected event type");
    await expect(
      runtime.readChannelDriftDecision({
        connectionId: "connection-1",
        channelListingId: "channel-foreign",
      }),
    ).resolves.toMatchObject({ revision: 0, accepted: null, repushRequested: false });
  });

  it("channel-missed-sale-sweep maps through the Link, rechecks Inventory authority, and retains backdating attention", async () => {
    await seedConnectionAndListings(pools.channels);
    let sweepAt = new Date("2026-09-12T06:00:00.000Z");
    const recordSale = vi.fn(
      async (command: Parameters<import("@chase-sets/inventory/server").RecordExternalChannelSale>[0]) => ({
        status: "committed" as const,
        sale: {
          saleKey: command.saleKey,
          saleStreamId: "inventory.external-channel-sale-synthetic",
          saleEventId: "evt_external_sale" as never,
          accountId: command.accountId as never,
          inventoryItemId: command.inventoryItemId,
          storageLocationId: command.storageLocationId,
          requestedQuantity: command.requestedQuantity,
          appliedQuantity: command.requestedQuantity,
          refusedQuantity: 0,
          protectedOrderIds: [],
          collisionPolicyRef: "inventory.external-channel-sale-collision/v1",
          collisionPolicyRevision: 1,
          inventoryAdjustmentEventId: "evt_inventory_adjustment" as never,
          saleShortfallKey: null,
          committedAt: "2026-09-12T06:00:00.000Z",
        },
      }),
    );
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: {
        enqueueReconciliationRepair: async () => null,
        enqueueRepush: async () => null,
        readOutboundOperationsByIds: async () => [],
      },
      channelSaleRecorder: recordSale,
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      clock: { now: () => sweepAt },
    });
    const registry = inlineRegistry(
      () => [
        state("external-repairable", "7", 1_000, 2, fingerprint("1")),
        state("external-foreign", "7", 1_000, 2, fingerprint("2")),
        state("external-structural", "7", 1_000, 2, fingerprint("3")),
      ],
      [
        {
          saleKey: {
            version: "v1",
            providerKey: "synthetic-reconciliation",
            sellerEnvironmentLineage: "sandbox",
            orderLineIdentity: "order-1:line-1",
          },
          externalListingId: "external-repairable",
          externalOfferId: null,
          requestedQuantity: 1,
          unitPriceAmount: "10.00",
          currencyCode: "USD",
          soldAt: "2026-09-11T00:00:00.000Z",
        },
      ],
    );
    await expect(
      runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).resolves.toMatchObject({ clean: false, counts: { missedSaleGaps: 1 } });
    expect(recordSale).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        accountId: "account-1",
        inventoryItemId: "item-repairable",
        storageLocationId: "location-1",
        requestedQuantity: 1,
        connectionAuditReference: "connection-1",
      }),
    );
    sweepAt = new Date("2026-09-12T06:01:00.000Z");
    await expect(
      runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).resolves.toMatchObject({ clean: true, counts: { missedSaleGaps: 0 } });
    expect(recordSale).toHaveBeenCalledTimes(2);
  });

  it("channel-sale-target-mapping returns a closed reason for every unmappable Link chain", async () => {
    await seedConnectionAndListings(pools.channels);
    const input = {
      connectionId: "connection-1",
      externalListingId: "external-repairable",
      externalOfferId: null,
    } as const;
    await expect(resolveChannelExternalSaleTarget(pools.channels, input)).resolves.toMatchObject({
      kind: "mapped",
      accountId: "account-1",
      inventoryItemId: "item-repairable",
      storageLocationId: "location-1",
    });
    await expect(
      resolveChannelExternalSaleTarget(pools.channels, {
        ...input,
        externalListingId: "missing",
      }),
    ).resolves.toEqual({ kind: "unmappable", reason: "link-not-found" });

    for (const [sql, reason] of [
      [
        `UPDATE channels_inventory_item_facts SET account_id='account-other' WHERE item_id='item-repairable'`,
        "account-mismatch",
      ],
      [
        `UPDATE channels_inventory_item_facts SET storage_location_id=NULL WHERE item_id='item-repairable'`,
        "storage-location-not-found",
      ],
      [`DELETE FROM channels_inventory_item_facts WHERE item_id='item-repairable'`, "item-not-found"],
      [
        `UPDATE channel_connections SET bindings='[]'::jsonb WHERE connection_id='connection-1'`,
        "storage-location-not-bound",
      ],
    ] as const) {
      await withPgTransaction(pools.channels, async (db) => {
        await db.query(sql);
        await expect(resolveChannelExternalSaleTarget(db, input)).resolves.toEqual({ kind: "unmappable", reason });
        throw rollback;
      }).catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    }

    await withPgTransaction(pools.channels, async (db) => {
      await db.query(
        `INSERT INTO channels_listing_publication_facts
           (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
            selected_options,selected_option_key,listing_status,updated_at,listing_stream_version)
         VALUES ('listing-duplicate','account-1','item-repairable','catalog-repairable','10.00','USD',2,
           '[]'::jsonb,'key','active',now(),1);
         INSERT INTO channels_channel_listing_links
           (connection_id,listing_id,channel_listing_id,external_listing_id,external_offer_id,publish_state,updated_at,last_stream_version)
         VALUES ('connection-1','listing-duplicate','channel-duplicate','external-repairable',NULL,'published',now(),1)`,
      );
      await expect(resolveChannelExternalSaleTarget(db, input)).resolves.toEqual({
        kind: "unmappable",
        reason: "duplicate-link",
      });
      throw rollback;
    }).catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
  });

  it("treats an exact Inventory sale committed before the sweep as authoritative and clean", async () => {
    await seedConnectionAndListings(pools.channels);
    await seedInventoryItem(pools.inventory, "item-repairable");
    const recorder = createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context);
    const sale = {
      saleKey: {
        version: "v1" as const,
        providerKey: "synthetic-reconciliation",
        sellerEnvironmentLineage: "sandbox-preexisting",
        orderLineIdentity: "order-preexisting:line-1",
      },
      externalListingId: "external-repairable",
      externalOfferId: null,
      requestedQuantity: 1,
      unitPriceAmount: "10.00",
      currencyCode: "USD",
      soldAt: "2026-09-10T00:00:00.000Z",
    };
    const preexisting = await recorder({
      accountId: "account-1",
      inventoryItemId: "item-repairable",
      storageLocationId: "location-1",
      saleKey: sale.saleKey,
      requestedQuantity: sale.requestedQuantity,
      unitPriceAmount: sale.unitPriceAmount,
      currencyCode: sale.currencyCode,
      soldAt: sale.soldAt,
      connectionAuditReference: "connection-1",
    });
    if (!("status" in preexisting)) throw new Error("Synthetic preexisting sale did not commit.");
    const sweepAt = new Date(Date.parse(preexisting.sale.committedAt) + 1_000);
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: {
        enqueueReconciliationRepair: async () => null,
        enqueueRepush: async () => null,
        readOutboundOperationsByIds: async () => [],
      },
      channelSaleRecorder: recorder,
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      clock: { now: () => sweepAt },
    });
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => matchingItems(), [sale]),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ clean: true, counts: { missedSaleGaps: 0, structural: 0 } });
    const authority = await pools.inventory.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_store_events
       WHERE event_type='inventory.external-channel-sale.recorded'`,
    );
    expect(authority.rows[0]?.count).toBe("1");
    const local = await pools.channels.query<{ gaps: string; receipts: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM channel_missed_sale_gaps WHERE open) AS gaps,
         (SELECT COUNT(*)::text FROM channel_recorded_sale_receipts) AS receipts`,
    );
    expect(local.rows[0]).toEqual({ gaps: "0", receipts: "1" });
  });

  it("fails closed when Inventory returns a different exact sale key", async () => {
    await seedConnectionAndListings(pools.channels);
    const line = {
      saleKey: {
        version: "v1" as const,
        providerKey: "synthetic-reconciliation",
        sellerEnvironmentLineage: "sandbox-key-mismatch",
        orderLineIdentity: "order-expected:line-1",
      },
      externalListingId: "external-repairable",
      externalOfferId: null,
      requestedQuantity: 1,
    };
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: {
        enqueueReconciliationRepair: async () => null,
        enqueueRepush: async () => null,
        readOutboundOperationsByIds: async () => [],
      },
      channelSaleRecorder: async () => ({
        status: "committed",
        sale: {
          saleKey: { ...line.saleKey, orderLineIdentity: "order-different:line-1" },
          saleStreamId: "inventory.external-channel-sale-different",
          saleEventId: "evt_different" as never,
          accountId: "account-1",
          inventoryItemId: "item-repairable",
          storageLocationId: "location-1",
          requestedQuantity: 1,
          appliedQuantity: 1,
          refusedQuantity: 0,
          protectedOrderIds: [],
          collisionPolicyRef: "inventory.external-channel-sale-collision/v1",
          collisionPolicyRevision: 1,
          inventoryAdjustmentEventId: "evt_different_adjustment" as never,
          saleShortfallKey: null,
          committedAt: "2026-09-12T06:00:00.000Z",
        },
      }),
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
    });
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => matchingItems(), [line]),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ state: "bounded-unknown", clean: false });
    const receipt = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channel_recorded_sale_receipts`,
    );
    expect(receipt.rows[0]?.count).toBe("0");
  });

  it("channel-missed-sale-gap-persistence alarms only after the bound and not from a bounded-unknown source", async () => {
    await seedConnectionAndListings(pools.channels);
    let saleSourceAvailable = true;
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: {
        enqueueReconciliationRepair: async () => null,
        enqueueRepush: async () => null,
        readOutboundOperationsByIds: async () => [],
      },
      channelSaleRecorder: async () => ({
        code: "external-channel-sale-history-invalid",
        saleStreamId: "inventory.external-channel-sale-unrecorded",
        reason: "empty-existing-stream",
        eventIndex: null,
      }),
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
    });
    const sale = {
      saleKey: {
        version: "v1" as const,
        providerKey: "synthetic-reconciliation",
        sellerEnvironmentLineage: "sandbox-gap",
        orderLineIdentity: "order-gap:line-1",
      },
      externalListingId: "external-repairable",
      externalOfferId: null,
      requestedQuantity: 1,
    };
    const registry = inlineRegistryWithSaleResult(
      () => [
        state("external-repairable", "7", 1_000, 2, fingerprint("1")),
        state("external-foreign", "7", 1_000, 2, fingerprint("2")),
        state("external-structural", "7", 1_000, 2, fingerprint("3")),
      ],
      async () =>
        saleSourceAvailable
          ? { kind: "complete", lines: [sale], collectedCount: 1, authorityTotal: 1, pageCount: 1 }
          : { kind: "bounded-unknown", reason: "source-error" },
    );
    const input = {
      connectionId: "connection-1",
      registry,
      sourceAttempt: 1,
      healthAuthority: { policyRevision: fingerprint("2"), evaluationGeneration: 3 },
    } as const;
    for (let run = 1; run <= 2; run += 1) {
      await expect(runtime.reconcileConnection(input, context)).resolves.toMatchObject({
        clean: false,
        counts: { missedSaleGaps: 1 },
      });
      const failures = (await runtime.readPendingHealthObservations({ limit: 100 })).filter(
        (observation) => observation.outcome === "failure",
      );
      expect(failures).toHaveLength(0);
    }
    await runtime.reconcileConnection(input, context);
    const afterPersistence = (await runtime.readPendingHealthObservations({ limit: 100 })).filter(
      (observation) => observation.outcome === "failure",
    );
    expect(afterPersistence).toHaveLength(1);
    await expect(
      runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({ affectedListingCount: 1, resolution: null });

    saleSourceAvailable = false;
    await runtime.reconcileConnection(input, context);
    const afterUnknown = (await runtime.readPendingHealthObservations({ limit: 100 })).filter(
      (observation) => observation.outcome === "failure",
    );
    expect(afterUnknown).toHaveLength(2);
    expect(
      afterUnknown.filter((observation) => observation.sourceWorkId !== afterPersistence[0]!.sourceWorkId),
    ).toHaveLength(1);
  });

  it("channel-drift-foreign-edit-resolutions retains a repush request when enqueue returns null", async () => {
    await seedConnectionAndListings(pools.channels);
    let operatorHeld = false;
    const enqueueRepush = vi.fn(async () => null);
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: {
        enqueueReconciliationRepair: async () => null,
        enqueueRepush,
        readOutboundOperationsByIds: async () => [],
      },
      channelSaleRecorder: async () => ({
        code: "external-channel-sale-history-invalid",
        saleStreamId: "unused",
        reason: "empty-existing-stream",
        eventIndex: null,
      }),
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({
        heldProviderKeys: operatorHeld ? ["inline-provider"] : [],
        heldConnectionIds: [],
      }),
      clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
    });
    const registry = inlineRegistry(() => driftItems());
    await runtime.reconcileConnection(
      { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
      context,
    );
    await expect(
      runtime.repushChannelListing(
        {
          connectionId: "connection-1",
          channelListingId: "channel-foreign",
          expectedDecisionRevision: 0,
          operationId: "repush-foreign-1",
        },
        context,
      ),
    ).resolves.toMatchObject({ revision: 1, accepted: null, repushRequested: true });

    operatorHeld = true;
    await expect(
      runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).resolves.toMatchObject({ state: "held" });
    await expect(
      runtime.readChannelDriftDecision({ connectionId: "connection-1", channelListingId: "channel-foreign" }),
    ).resolves.toMatchObject({ repushRequested: true });
    expect(enqueueRepush).toHaveBeenCalledTimes(1);

    operatorHeld = false;
    await runtime.reconcileConnection(
      { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
      context,
    );
    expect(enqueueRepush).toHaveBeenCalledTimes(2);
    expect(enqueueRepush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channelListingId: "channel-foreign",
        repushOperationId: "repush-foreign-1",
      }),
      expect.objectContaining({ query: expect.any(Function) }),
    );
    await expect(
      runtime.readChannelDriftDecision({ connectionId: "connection-1", channelListingId: "channel-foreign" }),
    ).resolves.toMatchObject({ repushRequested: true });
  });

  it.each(["pending", "failed"] as const)(
    "does not count a %s correction as succeeded after matching provider state",
    async (repairStatus) => {
      await seedConnectionAndListings(pools.channels);
      const outbound = realOutboundRuntime();
      const readOutboundOperationsByIds = vi.spyOn(outbound, "readOutboundOperationsByIds");
      const expected = await readExpectedReconciliationListings(pools.channels, {
        connectionId: "connection-1",
        limit: 10,
      });
      const repairable = expected.items.find((item) => item.channelListingId === "channel-repairable")!;
      const original = await outbound.enqueueDesiredState(repairable.desired);
      await pools.channels.query(
        `UPDATE channel_outbound_operations SET status='succeeded',terminal_at=$2
         WHERE operation_id=$1 AND status='pending'`,
        [original!.operationId, "2026-09-12T05:30:00.000Z"],
      );
      let observed = matchingItems({ repairableRevision: "6" });
      const runtime = reconciliationWithOutbound(outbound, () => observed);
      await expect(
        runtime.reconcileConnection(
          {
            connectionId: "connection-1",
            registry: inlineRegistry(() => observed),
            sourceAttempt: 1,
            healthAuthority: null,
          },
          context,
        ),
      ).resolves.toMatchObject({ counts: { repairable: 1, repairsEnqueued: 1, repairsSucceeded: 0 } });
      const repair = await pools.channels.query<{ operation_id: string; status: string }>(
        `SELECT operation_id,status FROM channel_outbound_operations
         WHERE channel_listing_id='channel-repairable' AND operation_origin='reconciliation-repair'`,
      );
      expect(repair.rows).toEqual([expect.objectContaining({ status: "pending" })]);
      if (repairStatus === "failed") {
        await pools.channels.query(
          `UPDATE channel_outbound_operations
           SET status='failed',terminal_reason='retry-exhausted',terminal_at=$2
           WHERE operation_id=$1 AND status='pending'`,
          [repair.rows[0]!.operation_id, "2026-09-12T05:45:00.000Z"],
        );
      }

      const differentRepair = await outbound.enqueueReconciliationRepair({
        ...repairable.desired,
        reconciliationRepairId: "synthetic-different-succeeded-correction",
      });
      expect(differentRepair!.operationId).not.toBe(repair.rows[0]!.operation_id);
      await pools.channels.query(
        `UPDATE channel_outbound_operations SET status='succeeded',terminal_at=$2
         WHERE operation_id=$1 AND status='pending'`,
        [differentRepair!.operationId, "2026-09-12T05:50:00.000Z"],
      );

      observed = matchingItems();
      readOutboundOperationsByIds.mockClear();
      const matchingInput = {
        connectionId: "connection-1",
        registry: inlineRegistry(() => observed),
        sourceAttempt: 1,
        healthAuthority: null,
      } as const;
      await expect(runtime.reconcileConnection(matchingInput, context)).resolves.toMatchObject({
        clean: true,
        counts: { repairsSucceeded: 0 },
      });
      expect(readOutboundOperationsByIds).toHaveBeenLastCalledWith({
        connectionId: "connection-1",
        operationIds: [repair.rows[0]!.operation_id],
      });
      expect(readOutboundOperationsByIds).toHaveBeenCalledTimes(1);
      await expect(
        pools.channels.query(
          `SELECT repair_succeeded_generation FROM channel_reconciliation_items
           WHERE connection_id='connection-1' AND channel_listing_id='channel-repairable'`,
        ),
      ).resolves.toMatchObject({ rows: [{ repair_succeeded_generation: null }] });
      await expect(runtime.reconcileConnection(matchingInput, context)).resolves.toMatchObject({
        counts: { repairsSucceeded: 0 },
      });
    },
  );

  it.each([
    ["connection_id", "synthetic-other-connection"],
    ["channel_listing_id", "synthetic-other-link"],
    ["listing_id", "synthetic-other-listing"],
    ["operation_kind", "publish"],
    ["listing_revision", 8],
    ["source_desired_state_sequence", 2],
    ["source_desired_state_hash", "f".repeat(64)],
  ] as const)("does not count an exact succeeded correction with a mismatched %s", async (column, value) => {
    await seedConnectionAndListings(pools.channels);
    const outbound = realOutboundRuntime();
    let observed = matchingItems({ repairableRevision: "6" });
    const runtime = reconciliationWithOutbound(outbound, () => observed);
    const input = () => ({
      connectionId: "connection-1",
      registry: inlineRegistry(() => observed),
      sourceAttempt: 1,
      healthAuthority: null,
    });
    await expect(runtime.reconcileConnection(input(), context)).resolves.toMatchObject({
      counts: { repairsEnqueued: 1, repairsSucceeded: 0 },
    });
    const repair = await pools.channels.query<{ operation_id: string }>(
      `SELECT repair_operation_id AS operation_id FROM channel_reconciliation_items
       WHERE connection_id='connection-1' AND channel_listing_id='channel-repairable'`,
    );
    // Desired sequence and stream version are one schema-constrained basis.
    const streamVersion = column === "source_desired_state_sequence" ? ",source_stream_version=$2" : "";
    const changed = await pools.channels.query(
      `UPDATE channel_outbound_operations SET ${column}=$2${streamVersion},status='succeeded',terminal_at=$3
       WHERE operation_id=$1 AND status='pending'`,
      [repair.rows[0]!.operation_id, value, "2026-09-12T05:50:00.000Z"],
    );
    expect(changed.rowCount).toBe(1);
    observed = matchingItems();
    await expect(runtime.reconcileConnection(input(), context)).resolves.toMatchObject({
      clean: true,
      counts: { repairsSucceeded: 0 },
    });
    await expect(
      pools.channels.query(
        `SELECT repair_succeeded_generation FROM channel_reconciliation_items
         WHERE connection_id='connection-1' AND channel_listing_id='channel-repairable'`,
      ),
    ).resolves.toMatchObject({ rows: [{ repair_succeeded_generation: null }] });
  });

  it("queues one distinct reconciliation repair behind a terminal desired operation and records one exact later success", async () => {
    await seedConnectionAndListings(pools.channels);
    const outbound = realOutboundRuntime();
    const readOutboundOperationsByIds = vi.spyOn(outbound, "readOutboundOperationsByIds");
    const expected = await readExpectedReconciliationListings(pools.channels, {
      connectionId: "connection-1",
      limit: 10,
    });
    const repairable = expected.items.find((item) => item.channelListingId === "channel-repairable")!;
    const pendingBasis = expected.items.find((item) => item.channelListingId === "channel-foreign")!;
    const inFlightBasis = expected.items.find((item) => item.channelListingId === "channel-structural")!;
    const pending = await outbound.enqueueDesiredState(pendingBasis.desired);
    const pendingRepair = await outbound.enqueueReconciliationRepair({
      ...pendingBasis.desired,
      reconciliationRepairId: "pending-basis-repair",
    });
    expect(pendingRepair).toMatchObject({ status: "pending" });
    const pendingRows = await pools.channels.query<{ operation_id: string }>(
      `SELECT operation_id FROM channel_outbound_operations
       WHERE channel_listing_id='channel-foreign' AND status='pending'`,
    );
    expect(new Set(pendingRows.rows.map((row) => row.operation_id))).toEqual(
      new Set([pending!.operationId, pendingRepair!.operationId]),
    );

    const inFlight = await outbound.enqueueDesiredState(inFlightBasis.desired);
    await pools.channels.query(
      `UPDATE channel_outbound_operations
       SET status='in-flight',attempt_id='attempt-in-flight',claim_generation=1,claimant_kind='inline',
           claim_owner_id='synthetic-owner',claimed_until='2026-09-12T06:10:00.000Z',attempt_count=1
       WHERE operation_id=$1 AND status='pending'`,
      [inFlight!.operationId],
    );
    const inFlightRepair = await outbound.enqueueReconciliationRepair({
      ...inFlightBasis.desired,
      reconciliationRepairId: "in-flight-basis-repair",
    });
    expect(inFlightRepair).toMatchObject({ status: "pending" });
    const retained = await pools.channels.query<{ status: string }>(
      `SELECT status FROM channel_outbound_operations
       WHERE channel_listing_id='channel-structural' ORDER BY status`,
    );
    expect(retained.rows.map((row) => row.status).sort()).toEqual(["in-flight", "pending"]);

    const original = await outbound.enqueueDesiredState(repairable.desired);
    expect(original).not.toBeNull();
    await pools.channels.query(
      `UPDATE channel_outbound_operations SET status='succeeded',terminal_at=$2
       WHERE operation_id=$1 AND status='pending'`,
      [original!.operationId, "2026-09-12T05:30:00.000Z"],
    );
    let observed = matchingItems({ repairableRevision: "6" });
    const runtime = reconciliationWithOutbound(outbound, () => observed);

    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => observed),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ counts: { repairable: 1, repairsEnqueued: 1 } });
    await runtime.reconcileConnection(
      {
        connectionId: "connection-1",
        registry: inlineRegistry(() => observed),
        sourceAttempt: 1,
        healthAuthority: null,
      },
      context,
    );
    const queued = await pools.channels.query<{
      operation_id: string;
      operation_origin: string;
      status: string;
    }>(
      `SELECT operation_id,operation_origin,status FROM channel_outbound_operations
       WHERE channel_listing_id='channel-repairable' ORDER BY enqueued_at,operation_id`,
    );
    expect(queued.rows).toHaveLength(2);
    expect(queued.rows.filter((row) => row.operation_origin === "reconciliation-repair")).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);

    const repair = queued.rows.find((row) => row.operation_origin === "reconciliation-repair")!;
    await pools.channels.query(
      `UPDATE channel_outbound_operations SET status='succeeded',terminal_at=$2
       WHERE operation_id=$1 AND status='pending'`,
      [repair.operation_id, "2026-09-12T05:45:00.000Z"],
    );
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(async () => {
            throw new Error("synthetic incomplete provider observation");
          }),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ state: "bounded-unknown", clean: false, counts: { repairsSucceeded: 0 } });
    observed = matchingItems();
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => observed),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ clean: true, counts: { repairsSucceeded: 1 } });
    expect(readOutboundOperationsByIds).toHaveBeenLastCalledWith({
      connectionId: "connection-1",
      operationIds: [repair.operation_id],
    });
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => observed),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ counts: { repairsSucceeded: 0 } });
  });

  it("consumes a repush only after the real queue returns its matching operation", async () => {
    await seedConnectionAndListings(pools.channels);
    const outbound = realOutboundRuntime();
    const expected = await readExpectedReconciliationListings(pools.channels, {
      connectionId: "connection-1",
      limit: 10,
    });
    const foreign = expected.items.find((item) => item.channelListingId === "channel-foreign")!;
    const blocker = await outbound.enqueueDesiredState(foreign.desired);
    expect(blocker).not.toBeNull();
    const observed = matchingItems({ foreignRevision: "foreign", foreignFingerprint: fingerprint("b") });
    const runtime = reconciliationWithOutbound(outbound, () => observed);
    const input = {
      connectionId: "connection-1",
      registry: inlineRegistry(() => observed),
      sourceAttempt: 1,
      healthAuthority: null,
    } as const;
    await runtime.reconcileConnection(input, context);
    await runtime.repushChannelListing(
      {
        connectionId: "connection-1",
        channelListingId: "channel-foreign",
        expectedDecisionRevision: 0,
        operationId: "repush-real-store-1",
      },
      context,
    );
    await runtime.reconcileConnection(input, context);
    await expect(
      runtime.readChannelDriftDecision({ connectionId: "connection-1", channelListingId: "channel-foreign" }),
    ).resolves.toMatchObject({ repushRequested: true, revision: 1 });

    await pools.channels.query(
      `UPDATE channel_outbound_operations SET status='succeeded',terminal_at=$2
       WHERE operation_id=$1 AND status='pending'`,
      [blocker!.operationId, "2026-09-12T05:40:00.000Z"],
    );
    await runtime.reconcileConnection(input, context);
    await expect(
      runtime.readChannelDriftDecision({ connectionId: "connection-1", channelListingId: "channel-foreign" }),
    ).resolves.toMatchObject({ repushRequested: false, revision: 2 });
    const repushes = await pools.channels.query<{ operation_origin: string; status: string }>(
      `SELECT operation_origin,status FROM channel_outbound_operations
       WHERE channel_listing_id='channel-foreign' AND operation_origin='repush'`,
    );
    expect(repushes.rows).toEqual([{ operation_origin: "repush", status: "pending" }]);
  });

  it("does not count null repairs or accepted foreign edits as successful corrections", async () => {
    await seedConnectionAndListings(pools.channels);
    let observed = matchingItems({ repairableRevision: "6" });
    const runtime = reconciliationAt(new Date("2026-09-12T06:00:00.000Z"));
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => observed),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ counts: { repairable: 1, repairsEnqueued: 0, repairsSucceeded: 0 } });
    observed = matchingItems();
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => observed),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ counts: { repairsSucceeded: 0 } });

    observed = matchingItems({ foreignRevision: "foreign", foreignFingerprint: fingerprint("b") });
    await runtime.reconcileConnection(
      {
        connectionId: "connection-1",
        registry: inlineRegistry(() => observed),
        sourceAttempt: 1,
        healthAuthority: null,
      },
      context,
    );
    await runtime.acceptChannelDrift(
      {
        connectionId: "connection-1",
        channelListingId: "channel-foreign",
        observedFingerprint: fingerprint("b"),
        expectedMaterialFingerprint: fingerprint("2"),
        expectedDecisionRevision: 0,
        operationId: "accept-no-repair-success",
      },
      context,
    );
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => observed),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ counts: { repairsSucceeded: 0 } });
  });

  it.each(["provider", "queue", "inventory"] as const)(
    "finalizes a %s exception as guarded bounded-unknown",
    async (failure) => {
      await seedConnectionAndListings(pools.channels);
      const sale = {
        saleKey: {
          version: "v1" as const,
          providerKey: "synthetic-reconciliation",
          sellerEnvironmentLineage: "sandbox-failure",
          orderLineIdentity: "order-failure:line-1",
        },
        externalListingId: "external-repairable",
        externalOfferId: null,
        requestedQuantity: 1,
      };
      const observed = failure === "queue" ? matchingItems({ repairableRevision: "6" }) : matchingItems();
      const registry =
        failure === "provider"
          ? inlineRegistry(() => {
              throw new Error("synthetic provider failure");
            })
          : inlineRegistry(() => observed, failure === "inventory" ? [sale] : []);
      const runtime = createChannelReconciliationRuntime({
        db: pools.channels,
        eventStore: createPostgresEventStore({ pool: pools.channels }),
        outboundSync: {
          enqueueReconciliationRepair: async (input) => {
            if (failure === "queue") throw new Error("synthetic queue failure");
            return pendingOperation(input);
          },
          enqueueRepush: async () => null,
          readOutboundOperationsByIds: async () => [],
        },
        channelSaleRecorder: async () => {
          if (failure === "inventory") throw new Error("synthetic inventory failure");
          return {
            code: "external-channel-sale-history-invalid",
            saleStreamId: "unused",
            reason: "empty-existing-stream",
            eventIndex: null,
          };
        },
        resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
        resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
        clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
      });
      await expect(
        runtime.reconcileConnection(
          { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
          context,
        ),
      ).resolves.toMatchObject({ state: "bounded-unknown", clean: false });
      const persisted = await pools.channels.query<{ state: string; lease_expires_at: Date | null }>(
        `SELECT state,lease_expires_at FROM channel_reconciliation_state WHERE connection_id='connection-1'`,
      );
      expect(persisted.rows[0]).toMatchObject({ state: "bounded-unknown", lease_expires_at: null });
    },
  );

  it("recovers one expired process-loss lease and never steals a live claimant", async () => {
    await seedConnectionAndListings(pools.channels);
    await plantRunningRun(pools.channels, "connection-1", "2026-09-12T06:01:00.000Z");
    const live = reconciliationAt(new Date("2026-09-12T06:00:30.000Z"));
    await expect(
      live.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => matchingItems()),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).rejects.toThrow("already claimed");
    const before = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_store_events
       WHERE stream_id='channels.channel-reconciliation-connection-1'`,
    );
    expect(before.rows[0]?.count).toBe("2");

    const recovered = reconciliationAt(new Date("2026-09-12T06:02:00.000Z"));
    await expect(
      recovered.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => matchingItems()),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ generation: 2, state: "completed", clean: true });
    const events = await pools.channels.query<{ event_type: string; stream_version: string }>(
      `SELECT event_type,stream_version::text FROM event_store_events
       WHERE stream_id='channels.channel-reconciliation-connection-1' ORDER BY stream_version`,
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      "channels.channel-reconciliation.due",
      "channels.channel-reconciliation.started",
      "channels.channel-reconciliation.finished",
      "channels.channel-reconciliation.due",
      "channels.channel-reconciliation.started",
      "channels.channel-reconciliation.finished",
    ]);
    const recoveredMetric = await pools.channels.query<{ run_state: string }>(
      `SELECT run_state FROM channel_reconciliation_metrics
       WHERE connection_id='connection-1' AND run_generation=1`,
    );
    expect(recoveredMetric.rows).toEqual([{ run_state: "bounded-unknown" }]);
  });

  it("rehydrates more than 3333 prior generations from an aggregate snapshot and bounded tail", async () => {
    await seedConnectionAndListings(pools.channels);
    const eventStore = createPostgresEventStore({ pool: pools.channels });
    let expectedVersion: "no_stream" | number = "no_stream";
    for (let firstGeneration = 1; firstGeneration <= 3_334; firstGeneration += 100) {
      const events = [];
      const lastGenerationInBatch = Math.min(firstGeneration + 99, 3_334);
      for (let generation = firstGeneration; generation <= lastGenerationInBatch; generation += 1) {
        const fingerprintValue = runFingerprint("connection-1", generation, 0);
        const instant = "2026-09-11T00:00:00.000Z";
        events.push(
          {
            eventType: "channels.channel-reconciliation.due",
            payload: {
              connectionId: "connection-1",
              generation,
              runFingerprint: fingerprintValue,
              cadencePolicyRevision: 0,
              dueAt: instant,
            },
          },
          {
            eventType: "channels.channel-reconciliation.started",
            payload: {
              connectionId: "connection-1",
              generation,
              runFingerprint: fingerprintValue,
              cadencePolicyRevision: 0,
              startedAt: instant,
              leaseExpiresAt: "2026-09-11T00:01:00.000Z",
            },
          },
          {
            eventType: "channels.channel-reconciliation.finished",
            payload: {
              connectionId: "connection-1",
              generation,
              runFingerprint: fingerprintValue,
              state: "completed",
              counts: emptyCounts(),
              clean: true,
              completedAt: instant,
            },
          },
        );
      }
      const appended = await eventStore.appendToStream({
        streamId: "channels.channel-reconciliation-connection-1",
        expectedVersion,
        context,
        events,
      });
      expectedVersion = appended.at(-1)!.streamVersion;
    }
    const lastGeneration = 3_334;
    const lastVersion = lastGeneration * 3;
    await createPostgresAggregateSnapshotStore({ db: pools.channels }).save({
      streamId: "channels.channel-reconciliation-connection-1",
      streamVersion: lastVersion,
      schemaVersion: 1,
      state: {
        generation: lastGeneration,
        state: "completed",
        runFingerprint: runFingerprint("connection-1", lastGeneration, 0),
        leaseExpiresAt: null,
        policyRevision: 0,
      },
    });
    await pools.channels.query(
      `INSERT INTO channel_reconciliation_state
         (connection_id,account_id,provider_key,environment,state,generation,revision,run_fingerprint,
          lease_expires_at,cadence_policy_revision,next_due_at,last_clean_run_at,counts,updated_at)
       VALUES ('connection-1','account-1','inline-provider','sandbox','completed',$1,1,$2,NULL,0,$3,$3,$4::jsonb,$3)`,
      [
        lastGeneration,
        runFingerprint("connection-1", lastGeneration, 0),
        "2026-09-12T05:00:00.000Z",
        JSON.stringify(emptyCounts()),
      ],
    );
    await expect(
      reconciliationAt(new Date("2026-09-12T06:00:00.000Z")).reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => matchingItems()),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ generation: 3_335, state: "completed" });
  });

  it("isolates a live-claimed connection from a later due connection", async () => {
    await seedConnectionAndListings(pools.channels);
    await seedBareConnection(pools.channels, "connection-0-bad");
    await plantRunningRun(pools.channels, "connection-0-bad", "2026-09-12T06:10:00.000Z");
    const runtime = reconciliationAt(new Date("2026-09-12T06:00:00.000Z"));
    const results = await runtime.reconcileDueConnections(
      { registry: inlineRegistry(() => matchingItems()), sourceAttempt: 1, healthAuthority: null, limit: 10 },
      () => context,
    );
    expect(results.map((result) => result.connectionId)).toEqual(["connection-1"]);
    expect(results[0]).toMatchObject({ state: "completed" });
  });

  it("keeps the exact attention generation open across an unknown run and resolves it once", async () => {
    await seedConnectionAndListings(pools.channels);
    let source: "drift" | "unknown" | "clean" = "drift";
    const registry = inlineRegistry(() => {
      if (source === "unknown") throw new Error("synthetic incomplete source");
      return source === "drift" ? driftItems() : matchingItems();
    });
    const runtime = reconciliationAt(new Date("2026-09-12T06:00:00.000Z"));
    const input = { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null } as const;
    await runtime.reconcileConnection(input, context);
    const opened = await runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" });
    expect(opened).toMatchObject({ generation: 1, resolution: null });

    source = "unknown";
    await expect(runtime.reconcileConnection(input, context)).resolves.toMatchObject({ state: "bounded-unknown" });
    await expect(runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" })).resolves.toEqual(
      opened,
    );

    source = "clean";
    await runtime.reconcileConnection(input, context);
    await runtime.reconcileConnection(input, context);
    const resolved = await runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" });
    expect(resolved).toMatchObject({
      generation: 1,
      fingerprint: opened!.fingerprint,
      resolution: "recovered-automatically",
    });
    const rows = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channel_reconciliation_attention_resolutions
       WHERE connection_id='connection-1' AND run_generation=1`,
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("does not close backdated attention through an intervening unknown sale source", async () => {
    await seedConnectionAndListings(pools.channels);
    let sweepAt = new Date("2026-09-12T06:00:00.000Z");
    const sale = {
      saleKey: {
        version: "v1" as const,
        providerKey: "synthetic-reconciliation",
        sellerEnvironmentLineage: "sandbox-backdated",
        orderLineIdentity: "order-backdated:line-1",
      },
      externalListingId: "external-repairable",
      externalOfferId: null,
      requestedQuantity: 1,
      soldAt: "2026-09-10T00:00:00.000Z",
    };
    let saleComplete = true;
    const registry = inlineRegistryWithSaleResult(
      () => matchingItems(),
      async () =>
        saleComplete
          ? { kind: "complete", lines: [sale], collectedCount: 1, authorityTotal: 1, pageCount: 1 }
          : { kind: "bounded-unknown", reason: "source-error" },
    );
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: {
        enqueueReconciliationRepair: async () => null,
        enqueueRepush: async () => null,
        readOutboundOperationsByIds: async () => [],
      },
      channelSaleRecorder: async () => ({
        status: "committed",
        sale: {
          saleKey: sale.saleKey,
          saleStreamId: "inventory.external-channel-sale-backdated",
          saleEventId: "evt_backdated" as never,
          accountId: "account-1",
          inventoryItemId: "item-repairable",
          storageLocationId: "location-1",
          requestedQuantity: 1,
          appliedQuantity: 1,
          refusedQuantity: 0,
          protectedOrderIds: [],
          collisionPolicyRef: "inventory.external-channel-sale-collision/v1",
          collisionPolicyRevision: 1,
          inventoryAdjustmentEventId: "evt_adjustment" as never,
          saleShortfallKey: null,
          committedAt: "2026-09-12T06:00:00.000Z",
        },
      }),
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      clock: { now: () => sweepAt },
    });
    const input = { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null } as const;
    await runtime.reconcileConnection(input, context);
    const opened = await runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" });
    expect(opened).toMatchObject({ generation: 1, resolution: null });

    saleComplete = false;
    sweepAt = new Date("2026-09-12T06:01:00.000Z");
    await runtime.reconcileConnection(input, context);
    await expect(runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" })).resolves.toEqual(
      opened,
    );

    saleComplete = true;
    sweepAt = new Date("2026-09-12T06:02:00.000Z");
    await runtime.reconcileConnection(input, context);
    await runtime.reconcileConnection(input, context);
    await expect(
      runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({
      generation: 1,
      fingerprint: opened!.fingerprint,
      resolution: "recovered-automatically",
    });
    const resolutions = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channel_reconciliation_attention_resolutions
       WHERE connection_id='connection-1' AND run_generation=1`,
    );
    expect(resolutions.rows[0]?.count).toBe("1");
  });

  it("advances beyond one health page only after exact replay-safe acknowledgments", async () => {
    const observations = [1, 2, 3].map((ordinal) => healthObservation(ordinal));
    for (const observation of observations) {
      await pools.channels.query(
        `INSERT INTO channel_reconciliation_health_observations
           (source_work_id,source_attempt,result_ordinal,payload,occurred_at)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [
          observation.sourceWorkId,
          observation.sourceAttempt,
          observation.resultOrdinal,
          JSON.stringify(observation),
          observation.occurredAt,
        ],
      );
    }
    const runtime = reconciliationAt(new Date("2026-09-12T06:00:00.000Z"));
    const page1 = await runtime.readPendingHealthObservations({ limit: 2 });
    expect(page1.map((row) => row.resultOrdinal)).toEqual([1, 2]);
    const identities = page1.map(({ sourceWorkId, sourceAttempt, resultOrdinal }) => ({
      sourceWorkId,
      sourceAttempt,
      resultOrdinal,
    }));
    const [first, concurrent] = await Promise.all([
      runtime.acknowledgeHealthObservations({ observations: identities }),
      runtime.acknowledgeHealthObservations({ observations: identities }),
    ]);
    expect([first.consumed, concurrent.consumed].sort()).toEqual([0, 2]);
    await expect(runtime.acknowledgeHealthObservations({ observations: identities })).resolves.toEqual({ consumed: 0 });
    await expect(runtime.readPendingHealthObservations({ limit: 2 })).resolves.toEqual([observations[2]]);
  });

  it("excludes only settled successful delists while retaining lingering provider state as structural", async () => {
    await seedConnectionAndListings(pools.channels);
    await createPostgresEventStore({ pool: pools.channels }).appendToStream({
      streamId: "channels.connection-connection-1",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "channels.connection.connected",
          payload: {
            connectionId: "connection-1",
            accountId: "account-1",
            providerKey: "inline-provider",
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
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context),
    });
    const connection = { connectionId: "connection-1", accountId: "account-1" };
    const runtime = reconciliationAt(new Date());
    const input = {
      connectionId: connection.connectionId,
      registry: inlineRegistry(() => []),
      sourceAttempt: 1,
      healthAuthority: (await services.connectionHealth.readConnectionHealth(connection)).health,
    };
    await expect(runtime.reconcileConnection(input, context)).resolves.toMatchObject({
      state: "completed",
      clean: false,
      counts: { structural: 3, sourceUnavailable: 0 },
    });
    const opening = await runtime.readChannelDriftAttentionContribution(connection);
    expect(opening).toMatchObject({ generation: 1, affectedListingCount: 3, resolution: null });
    await expect(runtime.deliverHealthObservations(services.connectionHealth, () => context)).resolves.toEqual({
      consumed: 1,
    });
    const source = createChannelActionAttentionSourceFromReadModel(pools.channels);
    expect(await source.load({ accountId: "account-1", now: new Date().toISOString() })).toHaveLength(1);
    const openedHealth = (await services.connectionHealth.readConnectionHealth(connection)).health.reasons[0]!;
    expect(openedHealth).toMatchObject({ reasonCode: "drift", state: "degraded", fingerprint: opening!.fingerprint });
    await authorAllDelists(pools.channels);
    await projectAllDelistsSucceeded(pools.channels);
    const settled = await pools.channels.query<{ publish_state: string }>(
      `SELECT publish_state FROM channels_channel_listing_links ORDER BY channel_listing_id`,
    );
    expect(settled.rows.map((row) => row.publish_state)).toEqual(["delisted", "delisted", "delisted"]);
    await expect(
      readExpectedReconciliationListings(pools.channels, { connectionId: "connection-1", limit: 10 }),
    ).resolves.toMatchObject({ items: [] });
    await expect(runtime.reconcileConnection(input, context)).resolves.toMatchObject({
      state: "completed",
      clean: true,
      counts: { structural: 0, sourceUnavailable: 0 },
    });
    const recovered = await runtime.readChannelDriftAttentionContribution(connection);
    expect(recovered).toMatchObject({
      generation: opening!.generation,
      fingerprint: opening!.fingerprint,
      affectedListingCount: 0,
      resolution: "recovered-automatically",
    });
    expect(recovered!.members).toEqual(opening!.members.map((member) => ({ ...member, settlement: "recovered" })));
    await expect(runtime.deliverHealthObservations(services.connectionHealth, () => context)).resolves.toEqual({
      consumed: 1,
    });
    await runtime.reconcileConnection(input, context);
    await runtime.deliverHealthObservations(services.connectionHealth, () => context);
    await expect(runtime.deliverHealthObservations(services.connectionHealth, () => context)).resolves.toEqual({
      consumed: 0,
    });
    expect((await services.connectionHealth.readConnectionHealth(connection)).health.reasons[0]).toMatchObject({
      reasonCode: "drift",
      generation: openedHealth.generation,
      fingerprint: opening!.fingerprint,
      state: "closed",
    });
    expect(await source.load({ accountId: "account-1", now: new Date().toISOString() })).toEqual([]);
    expect(
      (
        await pools.channels.query(
          "SELECT fingerprint,reason_generation::int,resolution_reason FROM channel_connection_attention",
        )
      ).rows,
    ).toEqual([
      {
        fingerprint: opening!.fingerprint,
        reason_generation: openedHealth.generation,
        resolution_reason: "recovered-automatically",
      },
    ]);
    expect(
      (
        await pools.channels.query(
          `SELECT payload->>'resolutionReason' AS resolution FROM event_store_events
           WHERE stream_id='channels.connection-attention-connection-1'
             AND payload->>'schemaVersion'='ChannelAttentionResolved/v1'`,
        )
      ).rows,
    ).toEqual([{ resolution: "recovered-automatically" }]);
    expect(
      (
        await pools.channels.query(
          `SELECT resolution FROM channel_reconciliation_attention_resolutions
           WHERE connection_id='connection-1' AND run_generation=1`,
        )
      ).rows,
    ).toEqual([{ resolution: "recovered-automatically" }]);

    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry: inlineRegistry(() => [state("external-repairable", "8", 1_000, 0, fingerprint("d"))]),
          sourceAttempt: 1,
          healthAuthority: null,
        },
        context,
      ),
    ).resolves.toMatchObject({ clean: false, counts: { structural: 1 } });

    await pools.channels.query(
      `UPDATE channels_channel_listing_links SET publish_state='failed'
       WHERE channel_listing_id='channel-foreign'`,
    );
    const failed = await readExpectedReconciliationListings(pools.channels, {
      connectionId: "connection-1",
      limit: 10,
    });
    expect(failed.items.map((item) => item.channelListingId)).toEqual(["channel-foreign"]);
  });

  it("retains original open delisted membership when the current sale source is unknown", async () => {
    await seedConnectionAndListings(pools.channels);
    const runtime = reconciliationAt(new Date());
    const input = { connectionId: "connection-1", sourceAttempt: 1, healthAuthority: null } as const;
    await runtime.reconcileConnection({ ...input, registry: inlineRegistry(() => []) }, context);
    const opening = await runtime.readChannelDriftAttentionContribution(input);
    expect(opening).toMatchObject({ generation: 1, affectedListingCount: 3, resolution: null });
    expect(opening!.members.every((member) => member.settlement === "open")).toBe(true);
    const membership = async () =>
      (await pools.channels.query("SELECT drift_generation FROM channel_reconciliation_state")).rows;
    const original = await membership();
    await authorAllDelists(pools.channels);
    await projectAllDelistsSucceeded(pools.channels);
    await expect(
      runtime.reconcileConnection(
        {
          ...input,
          registry: inlineRegistryWithSaleResult(
            () => [],
            async () => ({ kind: "bounded-unknown", reason: "source-error" }),
          ),
        },
        context,
      ),
    ).resolves.toMatchObject({ state: "bounded-unknown", clean: false });
    expect(await membership()).toEqual(original);
    await expect(runtime.readChannelDriftAttentionContribution(input)).resolves.toEqual(opening);
    expect((await pools.channels.query("SELECT 1 FROM channel_reconciliation_attention_resolutions")).rows).toEqual([]);
  });

  it("keeps the claimed arm memberless, bounded unknown, and free of provider and health work", async () => {
    await seedConnectionAndListings(pools.channels, "claimed-provider");
    const registry = createChannelProviderRegistry([descriptor("claimed-provider", { execution: "claimed" })]);
    const runtime = createRuntime(registry);
    await expect(
      runtime.reconcileConnection(
        {
          connectionId: "connection-1",
          registry,
          sourceAttempt: 1,
          healthAuthority: { policyRevision: fingerprint("1"), evaluationGeneration: 1 },
        },
        context,
      ),
    ).resolves.toMatchObject({ state: "bounded-unknown", clean: false, counts: { sourceUnavailable: 3 } });
    await expect(runtime.readPendingHealthObservations({ limit: 10 })).resolves.toEqual([]);
  });
});

function createRuntime(_registry: ReturnType<typeof createChannelProviderRegistry>) {
  return createChannelReconciliationRuntime({
    db: pools.channels,
    eventStore: createPostgresEventStore({ pool: pools.channels }),
    outboundSync: {
      enqueueReconciliationRepair: async () => null,
      enqueueRepush: async () => null,
      readOutboundOperationsByIds: async () => [],
    },
    channelSaleRecorder: async () => ({
      code: "external-channel-sale-history-invalid",
      saleStreamId: "unused",
      reason: "empty-existing-stream",
      eventIndex: null,
    }),
    resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
    resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
    clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
  });
}

function inlineRegistry(
  read: () => readonly ChannelStateLineV1[] | Promise<readonly ChannelStateLineV1[]>,
  sales: readonly import("../../publication-port/domain/contracts").ChannelSaleLineV1[] = [],
) {
  return inlineRegistryWithSaleResult(read, async () => ({
    kind: "complete",
    lines: sales,
    collectedCount: sales.length,
    authorityTotal: sales.length,
    pageCount: 1,
  }));
}

function inlineRegistryWithSaleResult(
  read: () => readonly ChannelStateLineV1[] | Promise<readonly ChannelStateLineV1[]>,
  fetchSales: () => Promise<import("../../publication-port/domain/contracts").ChannelSaleFetchResult>,
) {
  return createChannelProviderRegistry([
    descriptor("inline-provider", {
      execution: "inline",
      publishListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
      updatePriceQuantity: async () => ({ kind: "succeeded", externalListingId: "unused" }),
      delistListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
      fetchChannelState: async () => {
        const items = await read();
        return { kind: "complete", items, collectedCount: items.length, authorityTotal: items.length, pageCount: 1 };
      },
      fetchSales,
    }),
  ]);
}

function descriptor(
  providerKey: string,
  publication: NonNullable<ChannelProviderDescriptor["publication"]>,
): ChannelProviderDescriptor {
  return {
    identity: { providerKey, environment: "sandbox" },
    setup: {
      providerKey,
      environment: "sandbox",
      requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
    },
    publication,
  };
}

function driftItems(): readonly ChannelStateLineV1[] {
  return [
    state("external-repairable", "6", 900, 1, fingerprint("a")),
    state("external-foreign", "foreign", 1_200, 1, fingerprint("b")),
  ];
}

function state(
  externalListingId: string,
  revision: string,
  amountMinor: number,
  quantity: number,
  value: string,
): ChannelStateLineV1 {
  return {
    externalListingId,
    externalOfferId: null,
    revision,
    price: { amountMinor, currency: "USD" },
    quantity,
    fingerprint: value,
  };
}

function pendingOperation(
  input: import("../../outbound-sync/domain/contracts").EnqueueOutboundReconciliationRepair,
): import("../../outbound-sync/domain/contracts").OutboundOperationRecord {
  return {
    operationId: `repair-${input.reconciliationRepairId}`,
    connectionId: input.connectionId,
    channelListingId: input.channelListingId,
    listingId: input.listingId,
    operationKind: input.operationKind,
    listingRevision: input.listingRevision,
    sourceDesiredStateSequence: input.desiredStateSequence,
    payload: input.payload,
    payloadDigest: fingerprint("f"),
    status: "pending",
    revision: 1,
    attemptId: null,
    claimGeneration: 0,
    claimantKind: null,
    claimOwnerId: null,
    reservationId: null,
    claimedUntil: null,
    attemptCount: 0,
    nextAttemptAt: input.envelope.sourceOccurredAt,
    lastRejectionCode: null,
    terminalReason: null,
    linkWriteState: "pending",
    sourceEventId: input.envelope.sourceEventId,
    sourceStreamId: input.envelope.sourceStreamId,
    sourceStreamVersion: input.envelope.sourceStreamVersion,
    sourceGlobalPosition: input.envelope.sourceGlobalPosition,
    sourceDesiredStateHash: input.desiredStateHash,
    sourceOccurredAt: input.envelope.sourceOccurredAt,
    enqueuedAt: input.envelope.sourceOccurredAt,
    firstClaimedAt: null,
    terminalAt: null,
  };
}

async function s5Setup() {
  await seedConnectionAndListings(pools.channels);
  const registry = inlineRegistry(() =>
    matchingItems({ foreignRevision: "foreign", foreignFingerprint: fingerprint("b") }),
  );
  await createRuntime(registry).reconcileConnection(
    { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
    context,
  );
  return {
    outbound: realOutboundRuntime(),
    command: {
      connectionId: "connection-1",
      channelListingId: "channel-foreign",
      expectedDecisionRevision: 0,
      operationId: "synthetic-s5-repush",
    },
  };
}

function s5Runtime(overrides: Partial<ChannelReconciliationRuntimeDependencies>) {
  return createChannelReconciliationRuntime({
    db: pools.channels,
    eventStore: createPostgresEventStore({ pool: pools.channels }),
    outboundSync: realOutboundRuntime(),
    channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context),
    resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
    resolveKillSwitch: async () => null,
    ...overrides,
  });
}

async function decisionEvents() {
  return createPostgresEventStore({ pool: pools.channels }).readStream({
    streamId: "channels.channel-drift-decision-connection-1-channel-foreign",
    fromVersion: 1,
  });
}

function realOutboundRuntime() {
  return createOutboundSyncRuntime(
    {
      db: pools.channels,
      readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
      clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
    },
    { assertDelistDirective: () => undefined },
  );
}

function reconciliationWithOutbound(
  outbound: ReturnType<typeof realOutboundRuntime>,
  _observed: () => readonly ChannelStateLineV1[],
) {
  return createChannelReconciliationRuntime({
    db: pools.channels,
    eventStore: createPostgresEventStore({ pool: pools.channels }),
    outboundSync: outbound,
    channelSaleRecorder: async () => ({
      code: "external-channel-sale-history-invalid",
      saleStreamId: "unused",
      reason: "empty-existing-stream",
      eventIndex: null,
    }),
    resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
    resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
    clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
  });
}

function reconciliationAt(at: Date) {
  return createChannelReconciliationRuntime({
    db: pools.channels,
    eventStore: createPostgresEventStore({ pool: pools.channels }),
    outboundSync: {
      enqueueReconciliationRepair: async () => null,
      enqueueRepush: async () => null,
      readOutboundOperationsByIds: async () => [],
    },
    channelSaleRecorder: async () => ({
      code: "external-channel-sale-history-invalid",
      saleStreamId: "unused",
      reason: "empty-existing-stream",
      eventIndex: null,
    }),
    resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
    resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
    clock: { now: () => at },
  });
}

function matchingItems(
  options: Readonly<{
    repairableRevision?: string;
    foreignRevision?: string;
    foreignFingerprint?: string;
  }> = {},
): readonly ChannelStateLineV1[] {
  return [
    state("external-repairable", options.repairableRevision ?? "7", 1_000, 2, fingerprint("1")),
    state("external-foreign", options.foreignRevision ?? "7", 1_000, 2, options.foreignFingerprint ?? fingerprint("2")),
    state("external-structural", "7", 1_000, 2, fingerprint("3")),
  ];
}

function emptyCounts() {
  return {
    listingsReconciled: 0,
    inSync: 0,
    repairable: 0,
    foreignEdit: 0,
    structural: 0,
    sourceUnavailable: 0,
    repairsEnqueued: 0,
    repairsSucceeded: 0,
    missedSaleGaps: 0,
  };
}

function runFingerprint(connectionId: string, generation: number, policyRevision: number): string {
  return createHash("sha256").update(`${connectionId}\0${generation}\0${policyRevision}`, "utf8").digest("hex");
}

async function seedBareConnection(db: PgTransactionalPool, connectionId: string) {
  await db.query(
    `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
     VALUES ($1,'account-1','inline-provider','sandbox','active',$2::date,$3::timestamptz,'[]'::jsonb,$3::timestamptz,1)`,
    [connectionId, "2026-09-12", "2026-09-12T05:00:00.000Z"],
  );
  await db.query(
    `INSERT INTO channels_connection_facts
       (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     VALUES ($1,'account-1','inline-provider','sandbox','active',$2,1)`,
    [connectionId, "2026-09-12T05:00:00.000Z"],
  );
}

async function plantRunningRun(db: PgTransactionalPool, connectionId: string, leaseExpiresAt: string) {
  const runAt = "2026-09-12T06:00:00.000Z";
  const fingerprintValue = runFingerprint(connectionId, 1, 0);
  await db.query(
    `INSERT INTO channel_reconciliation_state
       (connection_id,account_id,provider_key,environment,state,generation,revision,run_fingerprint,
        lease_expires_at,cadence_policy_revision,next_due_at,last_clean_run_at,counts,updated_at)
     VALUES ($1,'account-1','inline-provider','sandbox','running',1,2,$2,$3,0,$4,NULL,$5::jsonb,$4)`,
    [connectionId, fingerprintValue, leaseExpiresAt, runAt, JSON.stringify(emptyCounts())],
  );
  await createPostgresEventStore({ pool: db }).appendToStream({
    streamId: `channels.channel-reconciliation-${connectionId}`,
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "channels.channel-reconciliation.due",
        payload: {
          connectionId,
          generation: 1,
          runFingerprint: fingerprintValue,
          cadencePolicyRevision: 0,
          dueAt: runAt,
        },
      },
      {
        eventType: "channels.channel-reconciliation.started",
        payload: {
          connectionId,
          generation: 1,
          runFingerprint: fingerprintValue,
          cadencePolicyRevision: 0,
          startedAt: runAt,
          leaseExpiresAt,
        },
      },
    ],
  });
}

async function seedInventoryItem(db: PgTransactionalPool, itemId: string) {
  await createPostgresEventStore({ pool: db }).appendToStream({
    streamId: `inventory.item-${itemId}`,
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "inventory.item.created",
        payload: {
          itemId,
          accountId: "account-1",
          catalogItemId: `catalog-${itemId}`,
          productId: `catalog-${itemId}::raw`,
          selectedOptions: [],
          gradedCard: null,
          storageLocationId: "location-1",
          totalQuantity: 10,
          acquisitionCostAmount: null,
          acquisitionCostCurrencyCode: null,
          acquisitionOccurrence: { kind: "unknown" },
        },
      },
    ],
  });
}

function healthObservation(resultOrdinal: number) {
  return {
    schemaVersion: "ChannelHealthObservation/v1" as const,
    sourceKind: "channel-reconciliation" as const,
    sourceWorkId: "synthetic-health-page",
    sourceAttempt: 1,
    resultOrdinal,
    policyRevision: fingerprint("1"),
    evaluationGeneration: 1,
    connectionId: "connection-1",
    reasonCode: "drift" as const,
    fingerprint: fingerprint(String(resultOrdinal)),
    outcome: "failure" as const,
    occurredAt: `2026-09-12T06:00:0${resultOrdinal}.000Z`,
  };
}

async function authorAllDelists(db: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool: db });
  for (const name of ["repairable", "foreign", "structural"] as const) {
    const channelListingId = `channel-${name}`;
    const listingId = `listing-${name}`;
    const desiredStateHash = fingerprint("d");
    const payload = {
      connectionId: "connection-1",
      channelListingId,
      listingId,
      listingRevision: 8,
      desiredStateSequence: 2,
      desiredStateHash,
      intent: "delist",
      delist: {
        channelListingId,
        listingRevision: 8,
        lastPublishedPrice: { amountMinor: 1_000, currency: "USD" },
        lastPublishedQuantity: 2,
        delistReasons: ["listing-not-active"],
      },
    };
    await eventStore.appendToStream({
      streamId: `channels.channel-listing-${channelListingId}`,
      expectedVersion: 1,
      context,
      events: [{ eventType: "channels.channel-listing.desired-state-changed", payload }],
    });
    await db.query(
      `UPDATE channels_channel_listing_links
       SET last_desired_state_sequence=2,last_desired_listing_revision=8,last_desired_state_hash=$2,
           last_desired_intent='delist',last_desired_payload=$3::jsonb,last_pushed_listing_revision=8,
           publish_state='published',updated_at=$4,last_stream_version=2
       WHERE channel_listing_id=$1`,
      [channelListingId, desiredStateHash, JSON.stringify(payload), "2026-09-12T05:30:00.000Z"],
    );
  }
}

async function projectAllDelistsSucceeded(db: PgTransactionalPool) {
  const handlers = buildChannelListingStateProjectionHandlers(db);
  for (const name of ["repairable", "foreign", "structural"] as const) {
    const channelListingId = `channel-${name}`;
    await handlers["channels.channel-listing.publication-recorded"]!(
      buildTransportEvent(
        "channels.channel-listing.publication-recorded",
        {
          connectionId: "connection-1",
          channelListingId,
          operationId: `operation-delist-${name}`,
          reportedDesiredStateSequence: 2,
          reportedListingRevision: 8,
          reportedDesiredStateHash: fingerprint("d"),
          outcome: {
            kind: "succeeded",
            externalListingId: `external-${name}`,
            externalOfferId: null,
            providerRevision: "provider-delisted",
          },
          adoption: "identity-and-state-applied",
        },
        {
          streamId: `channels.channel-listing-${channelListingId}`,
          streamVersion: 3,
          globalPosition: `delist-${name}:3`,
        },
      ),
    );
  }
}

async function seedConnectionAndListings(db: PgTransactionalPool, providerKey = "inline-provider") {
  await db.query(
    `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
     VALUES ('connection-1','account-1',$1,'sandbox','active','2026-09-12T05:00:00.000Z','2026-09-12T05:00:00.000Z',
       '[{"storageLocationId":"location-1","revision":1}]'::jsonb,now(),2)`,
    [providerKey],
  );
  await db.query(
    `INSERT INTO channels_connection_facts
       (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     VALUES ('connection-1','account-1',$1,'sandbox','active',now(),2)`,
    [providerKey],
  );
  const eventStore = createPostgresEventStore({ pool: db });
  for (const [name, hash] of [
    ["repairable", "1"],
    ["foreign", "2"],
    ["structural", "3"],
  ] as const) {
    const channelListingId = `channel-${name}`;
    const listingId = `listing-${name}`;
    const externalListingId = `external-${name}`;
    const desiredStateHash = fingerprint(hash);
    const draft = {
      channelListingId,
      listingRevision: 7,
      title: name,
      description: "synthetic",
      categoryKey: "category",
      conditionKey: "condition",
      price: { amountMinor: 1_000, currency: "USD" },
      quantity: 2,
      attributes: [],
    };
    await eventStore.appendToStream({
      streamId: `channels.channel-listing-${channelListingId}`,
      expectedVersion: "no_stream",
      context,
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
      [listingId, `item-${name}`, `catalog-${name}`],
    );
    await db.query(
      `INSERT INTO channels_inventory_item_facts
         (item_id,account_id,catalog_item_id,storage_location_id,total_quantity,updated_at,item_stream_version)
       VALUES ($1,'account-1',$2,'location-1',2,now(),1)`,
      [`item-${name}`, `catalog-${name}`],
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
        externalListingId,
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

async function moveExpectedForeignMaterial(db: PgTransactionalPool) {
  const desiredStateHash = fingerprint("4");
  const draft = {
    channelListingId: "channel-foreign",
    listingRevision: 8,
    title: "foreign moved",
    description: "synthetic",
    categoryKey: "category",
    conditionKey: "condition",
    price: { amountMinor: 1_100, currency: "USD" },
    quantity: 2,
    attributes: [],
  };
  const payload = {
    connectionId: "connection-1",
    channelListingId: "channel-foreign",
    listingId: "listing-foreign",
    listingRevision: 8,
    desiredStateSequence: 2,
    desiredStateHash,
    intent: "update",
    draft,
  };
  await createPostgresEventStore({ pool: db }).appendToStream({
    streamId: "channels.channel-listing-channel-foreign",
    expectedVersion: 1,
    context,
    events: [{ eventType: "channels.channel-listing.desired-state-changed", payload }],
  });
  await db.query(
    `UPDATE channels_channel_listing_links
     SET last_desired_state_sequence=2,last_desired_listing_revision=8,last_desired_state_hash=$2,
         last_desired_payload=$3::jsonb,updated_at=now(),last_stream_version=2
     WHERE channel_listing_id=$1`,
    ["channel-foreign", desiredStateHash, JSON.stringify(payload)],
  );
}

function fingerprint(character: string): string {
  return character.repeat(64);
}
