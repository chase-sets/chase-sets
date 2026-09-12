import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import type { ChannelProviderDescriptor, ChannelStateLineV1 } from "../../publication-port/domain/contracts";
import { createChannelReconciliationRuntime } from "../api/runtime";
import { CHANNEL_RECONCILIATION_POLICY_FALLBACK } from "../domain/policy";
import { resolveChannelExternalSaleTarget } from "../read-model/sale-target";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;
const rollback = Symbol("rollback test transaction");
const context: EventStoreContext = {
  tenantId: "tnt_reconciliation_test" as never,
  audit: { performedByUserId: "usr_reconciliation_test" as never, forAccountId: "account-1" as never },
};

describeDb("Channel Reconciliation guarded production path", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_reconciliation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("channel-seeded-drift-drill classifies three classes, enqueues only repairable, and retains bounded attention", async () => {
    await seedConnectionAndListings(pools.channels);
    let observed = driftItems();
    const enqueueDesiredState = vi.fn(
      async (_input: import("../../outbound-sync/domain/contracts").EnqueueOutboundOperation) => null,
    );
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: { enqueueDesiredState, enqueueRepush: vi.fn(async () => null) },
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
        healthAuthority: { policyRevision: 2, evaluationGeneration: 3 },
      },
      context,
    );
    expect(result).toMatchObject({
      state: "completed",
      clean: false,
      counts: { listingsReconciled: 3, repairable: 1, foreignEdit: 1, structural: 1, repairsEnqueued: 1 },
    });
    expect(enqueueDesiredState).toHaveBeenCalledTimes(1);
    expect(enqueueDesiredState.mock.calls[0]![0]).toMatchObject({ channelListingId: "channel-repairable" });
    await expect(
      runtime.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({
      connectionId: "connection-1",
      generation: 1,
      affectedListingCount: 2,
      hasMore: 0,
    });
    await expect(runtime.readPendingHealthObservations({ limit: 10 })).resolves.toHaveLength(3);

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
        healthAuthority: { policyRevision: 2, evaluationGeneration: 3 },
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
    expect(enqueueDesiredState).toHaveBeenCalledTimes(2);

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
    expect(enqueueDesiredState).toHaveBeenCalledTimes(2);
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

  it("channel-missed-sale-sweep maps through the Link, records exactly once, and retains backdating attention", async () => {
    await seedConnectionAndListings(pools.channels);
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
      outboundSync: { enqueueDesiredState: async () => null, enqueueRepush: async () => null },
      channelSaleRecorder: recordSale,
      resolvePolicy: async () => ({ value: CHANNEL_RECONCILIATION_POLICY_FALLBACK, revision: 0 }),
      resolveKillSwitch: async () => ({ heldProviderKeys: [], heldConnectionIds: [] }),
      clock: { now: () => new Date("2026-09-12T06:00:00.000Z") },
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
    await expect(
      runtime.reconcileConnection(
        { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
        context,
      ),
    ).resolves.toMatchObject({ clean: true, counts: { missedSaleGaps: 0 } });
    expect(recordSale).toHaveBeenCalledTimes(1);
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

  it("channel-missed-sale-gap-persistence alarms only after the bound and not from a bounded-unknown source", async () => {
    await seedConnectionAndListings(pools.channels);
    let saleSourceAvailable = true;
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: { enqueueDesiredState: async () => null, enqueueRepush: async () => null },
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
      healthAuthority: { policyRevision: 2, evaluationGeneration: 3 },
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

  it("channel-drift-foreign-edit-resolutions retains a repush request across an outbound hold", async () => {
    await seedConnectionAndListings(pools.channels);
    let operatorHeld = false;
    const enqueueRepush = vi.fn(async () => null);
    const runtime = createChannelReconciliationRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      outboundSync: { enqueueDesiredState: async () => null, enqueueRepush },
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
    expect(enqueueRepush).not.toHaveBeenCalled();

    operatorHeld = false;
    await runtime.reconcileConnection(
      { connectionId: "connection-1", registry, sourceAttempt: 1, healthAuthority: null },
      context,
    );
    expect(enqueueRepush).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channelListingId: "channel-foreign",
        repushOperationId: "repush-foreign-1",
      }),
    );
    await expect(
      runtime.readChannelDriftDecision({ connectionId: "connection-1", channelListingId: "channel-foreign" }),
    ).resolves.toMatchObject({ repushRequested: false });
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
          healthAuthority: { policyRevision: 1, evaluationGeneration: 1 },
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
    outboundSync: { enqueueDesiredState: async () => null, enqueueRepush: async () => null },
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
