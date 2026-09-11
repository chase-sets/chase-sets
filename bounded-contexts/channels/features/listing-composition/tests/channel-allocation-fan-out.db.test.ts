import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, createSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { module as channelsModule, contextManifest } from "../../../index";
import { module as inventoryModule } from "../../../../inventory/index";
import {
  decideInventoryItem,
  initialInventoryItemState,
} from "../../../../inventory/features/inventory-items/domain/domain";
import { createChannelCompositionProfileRegistry, deriveChannelSelectedOptionKey } from "../domain/canonical";
import {
  CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK,
  channelStockAllocationBufferPolicy,
  deriveChannelPublishQuantity,
  resolveChannelStockAllocationBufferPolicy,
} from "../domain/allocation";
import { CHANNEL_STOCK_ALLOCATION_SUBSCRIPTION_VERSION } from "../integrations/reactions";
import { buildChannelInventoryFactsProjectionHandlers } from "../read-model/facts-projection";
import { syntheticProfile } from "./test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory", "channels"] as const;
type Pools = Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
const context: EventStoreContext = {
  tenantId: "tnt_synthetic_channel_allocation" as never,
  audit: {
    performedByUserId: "usr_synthetic_channel_allocation" as never,
    forAccountId: "account-synthetic" as never,
  },
};

describeDb("channel-allocation-change-fan-out / channel-allocation-sale-fan-out", () => {
  let pools: Pools;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "channel_allocation_fan_out");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await seedCompositionFacts(pools.channels);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("propagates mode, units, and no-op revisions only to affected desired states", async () => {
    const services = channelsModule.createServices(pools.channels, {});
    await seedInitialDesiredStates(services.listingComposition);
    const initial = await desiredStates(pools.channels);
    expect(initial.map((row) => [row.connectionId, row.listingId, row.quantity])).toEqual([
      ["connection-a", "listing-target", 10],
      ["connection-b", "listing-target", 10],
      ["connection-control", "listing-control", 8],
    ]);

    const source = createPostgresEventStore({ pool: pools.inventory });
    const inventoryServices = inventoryModule.createServices(pools.inventory, {});
    const subscriptions = subscriptionsFor(services);
    expect(CHANNEL_STOCK_ALLOCATION_SUBSCRIPTION_VERSION).toBe(2);
    expect(subscriptions.inventoryProjection.subscriptionVersion).toBe(CHANNEL_STOCK_ALLOCATION_SUBSCRIPTION_VERSION);
    expect(subscriptions.inventoryReaction.subscriptionVersion).toBe(CHANNEL_STOCK_ALLOCATION_SUBSCRIPTION_VERSION);
    expect(subscriptions.inventoryProjection.eventTypes).toContain("inventory.channel-stock-allocation.set");
    expect(subscriptions.inventoryReaction.eventTypes).toContain("inventory.channel-stock-allocation.set");
    expect(contextManifest.allowedContextDependencies).toEqual([]);

    const runners = createRunners(subscriptions);
    await setAllocation(inventoryServices.channelStockAllocations, 0, [
      { channelConnectionId: "connection-a", units: 2 },
      { channelConnectionId: "connection-b", units: 4 },
      { channelConnectionId: "connection-without-link", units: 99 },
    ]);
    await drainAllocationPipeline(runners);
    const modeSwitch = (await desiredStates(pools.channels)).slice(initial.length);
    expect(modeSwitch.map((row) => [row.connectionId, row.listingId, row.quantity])).toEqual([
      ["connection-a", "listing-target", 2],
      ["connection-b", "listing-target", 4],
    ]);
    expect(modeSwitch.some((row) => row.connectionId === "connection-without-link")).toBe(false);

    await setAllocation(inventoryServices.channelStockAllocations, 1, [
      { channelConnectionId: "connection-a", units: 3 },
      { channelConnectionId: "connection-b", units: 4 },
      { channelConnectionId: "connection-without-link", units: 99 },
    ]);
    await drainAllocationPipeline(runners);
    const unitsRevision = (await desiredStates(pools.channels)).slice(initial.length + modeSwitch.length);
    expect(unitsRevision.map((row) => [row.connectionId, row.listingId, row.quantity])).toEqual([
      ["connection-a", "listing-target", 3],
    ]);

    const beforeNoOp = await desiredStates(pools.channels);
    await setAllocation(inventoryServices.channelStockAllocations, 2, [
      { channelConnectionId: "connection-a", units: 3 },
      { channelConnectionId: "connection-b", units: 4 },
      { channelConnectionId: "connection-without-link", units: 100 },
    ]);
    await drainAllocationPipeline(runners);
    expect(await desiredStates(pools.channels)).toEqual(beforeNoOp);
    expect((await desiredStates(pools.channels)).filter((row) => row.connectionId === "connection-control")).toEqual([
      expect.objectContaining({ listingId: "listing-control", quantity: 8 }),
    ]);

    const projected = await pools.channels.query<{ allocation_stream_version: string; partitions: unknown }>(
      "SELECT allocation_stream_version::text,partitions FROM channels_inventory_allocation_facts WHERE item_id='item-target'",
    );
    expect(projected.rows).toEqual([
      {
        allocation_stream_version: "3",
        partitions: [
          { channelConnectionId: "connection-a", units: 3 },
          { channelConnectionId: "connection-b", units: 4 },
          { channelConnectionId: "connection-without-link", units: 100 },
        ],
      },
    ]);
  });

  it("fans a synthetic recorded external sale adjustment to every other connection and writes no next-day desired state", async () => {
    const services = channelsModule.createServices(pools.channels, {});
    const inventoryServices = inventoryModule.createServices(pools.inventory, {});
    await seedInitialDesiredStates(services.listingComposition);
    const beforeSale = await desiredStates(pools.channels);
    const source = createPostgresEventStore({ pool: pools.inventory });
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "item-target" as never,
      accountId: "account-synthetic" as never,
      catalogItemId: "catalog-target" as never,
      productId: "product-synthetic-target" as never,
      selectedOptions: [],
      storageLocationId: "location-synthetic",
      totalQuantity: 10,
      acquisitionCostAmount: "10.00",
      acquisitionCostCurrencyCode: "USD",
      acquisitionOccurrence: { kind: "unknown" },
      commandOccurredAt: "2026-09-09T18:00:00.000Z",
    });
    await source.appendToStream({
      streamId: "inventory.item-item-target",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: created!.type, payload: created!.data }],
    });
    await expect(
      inventoryServices.channelSales.record(
        {
          accountId: "account-synthetic",
          inventoryItemId: "item-target",
          storageLocationId: "location-synthetic",
          saleKey: {
            version: "v1",
            providerKey: "synthetic-provider",
            sellerEnvironmentLineage: "synthetic-production-lineage",
            orderLineIdentity: "synthetic-order-line-allocation-proof",
          },
          requestedQuantity: 1,
          unitPriceAmount: "20.00",
          currencyCode: "USD",
          soldAt: "2026-09-10T18:00:00.000Z",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "committed", sale: { appliedQuantity: 1, refusedQuantity: 0 } });

    const subscriptions = subscriptionsFor(services);
    const runners = createRunners(subscriptions);
    await drainAllocationPipeline(runners);
    const saleChanges = (await desiredStates(pools.channels)).slice(beforeSale.length);
    expect(saleChanges.map((row) => [row.connectionId, row.listingId, row.quantity])).toEqual([
      ["connection-a", "listing-target", 9],
      ["connection-b", "listing-target", 9],
    ]);
    const sourceCounts = await pools.inventory.query<{ event_type: string; count: string }>(
      `SELECT event_type,count(*)::text AS count FROM event_store_events
       WHERE event_type IN ('inventory.external-channel-sale.recorded','inventory.item.adjusted')
       GROUP BY event_type ORDER BY event_type`,
    );
    expect(sourceCounts.rows).toEqual([
      { event_type: "inventory.external-channel-sale.recorded", count: "1" },
      { event_type: "inventory.item.adjusted", count: "1" },
    ]);

    const beforeReplay = await desiredStates(pools.channels);
    await pools.channels.query("DELETE FROM event_subscription_checkpoints WHERE checkpoint_key = ANY($1::text[])", [
      [runners.inventoryProjection.checkpointKey, runners.inventoryReaction.checkpointKey],
    ]);
    const replayRunners = createRunners(subscriptions);
    await drainAllocationPipeline(replayRunners);
    expect(await desiredStates(pools.channels)).toEqual(beforeReplay);
  });

  it("channel-stock-allocation-policy-value proves no-document, malformed, and explicit revision paths", async () => {
    const source = createPostgresEventStore({ pool: pools.channels });
    const noDocumentRuntime = createPolicyRuntime({ eventStore: source, db: pools.channels });
    const noDocument = await resolveChannelStockAllocationBufferPolicy(
      async () => (await noDocumentRuntime.resolvePolicy(channelStockAllocationBufferPolicy)).value,
    );
    expect(noDocument).toEqual(CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK);
    expect(
      deriveChannelPublishQuantity({
        available: 4,
        listingQuantityCap: 10,
        channelConnectionId: "connection-a",
        allocation: { mode: "shared-pool", partitions: [] },
        buffer: noDocument,
      }),
    ).toBe(4);

    await insertPolicyValue({ bufferThresholdUnits: 5, bufferHoldbackUnits: "malformed" });
    const malformedRuntime = createPolicyRuntime({ eventStore: source, db: pools.channels });
    await expect(malformedRuntime.resolvePolicy(channelStockAllocationBufferPolicy)).rejects.toThrow(
      "Invalid inventory Channel Stock Allocation buffer policy",
    );
    const fallbackRuntime = createPolicyRuntime({ eventStore: source, db: pools.channels });
    await expect(
      resolveChannelStockAllocationBufferPolicy(
        async () => (await fallbackRuntime.resolvePolicy(channelStockAllocationBufferPolicy)).value,
      ),
    ).resolves.toEqual(CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK);

    await pools.channels.query("DELETE FROM platform_policy_documents");
    const revisedRuntime = createPolicyRuntime({ eventStore: source, db: pools.channels });
    const { documentId } = await revisedRuntime.createPolicyDocument(
      channelStockAllocationBufferPolicy,
      {
        value: { bufferThresholdUnits: 0, bufferHoldbackUnits: 0 },
        status: "active",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_synthetic_policy_operator",
      },
      context,
    );
    await projectPolicyTail(revisedRuntime, source, documentId);
    await revisedRuntime.resolvePolicy(channelStockAllocationBufferPolicy);
    await revisedRuntime.revisePolicyDocument(
      channelStockAllocationBufferPolicy,
      documentId,
      {
        value: { bufferThresholdUnits: 5, bufferHoldbackUnits: 2 },
        status: "active",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_synthetic_policy_operator",
      },
      context,
    );
    await projectPolicyTail(revisedRuntime, source, documentId);
    const revised = await resolveChannelStockAllocationBufferPolicy(
      async () => (await revisedRuntime.resolvePolicy(channelStockAllocationBufferPolicy)).value,
    );
    expect(
      deriveChannelPublishQuantity({
        available: 4,
        listingQuantityCap: 10,
        channelConnectionId: "connection-a",
        allocation: { mode: "shared-pool", partitions: [] },
        buffer: revised,
      }),
    ).toBe(2);
  });

  it("guards the Channels allocation-fact write against an interleaved older revision", async () => {
    const handlers = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    const allocationEvent = (units: number, streamVersion: number) =>
      buildTransportEvent(
        "inventory.channel-stock-allocation.set",
        {
          eventVersion: 1,
          accountId: "account-synthetic",
          inventoryItemId: "item-interleaving",
          mode: "partitioned",
          partitions: [{ channelConnectionId: "connection-a", units }],
          setAt: `2026-09-11T18:0${streamVersion}:00.000Z`,
        },
        { streamId: "inventory.channel-stock-allocation-item-interleaving", streamVersion },
      );
    await handlers["inventory.channel-stock-allocation.set"]!(allocationEvent(7, 2));
    await handlers["inventory.channel-stock-allocation.set"]!(allocationEvent(2, 1));
    const result = await pools.channels.query<{ allocation_stream_version: string; partitions: unknown }>(
      "SELECT allocation_stream_version::text,partitions FROM channels_inventory_allocation_facts WHERE item_id='item-interleaving'",
    );
    expect(result.rows).toEqual([
      {
        allocation_stream_version: "2",
        partitions: [{ channelConnectionId: "connection-a", units: 7 }],
      },
    ]);
  });

  async function insertPolicyValue(value: Record<string, unknown>) {
    await pools.channels.query(
      `INSERT INTO platform_policy_documents
       (document_id,policy_key,context_name,schema_summary,status,value,effective_from,effective_until,created_at,updated_at)
       VALUES ('policy-document-synthetic','inventory.channel-stock-allocation-buffer','inventory','synthetic policy','active',$1::jsonb,
         '2026-09-01T00:00:00Z',NULL,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`,
      [JSON.stringify(value)],
    );
  }

  async function projectPolicyTail(
    runtime: ReturnType<typeof createPolicyRuntime>,
    source: ReturnType<typeof createPostgresEventStore>,
    documentId: string,
  ) {
    const events = await source.readStream({ streamId: `platform-policy.document-${documentId}` });
    const stored = events.at(-1)!;
    const handler = runtime.projectors[0]!.handlers[stored.eventType];
    if (!handler) throw new Error("Platform policy projector is missing its authored event handler.");
    await handler(
      buildTransportEvent(stored.eventType, stored.payload, {
        id: stored.eventId,
        streamId: stored.streamId,
        streamVersion: stored.streamVersion,
        globalPosition: stored.globalPosition,
        tenantId: stored.tenantId,
        audit: { performedByUserId: stored.performedByUserId, forAccountId: stored.forAccountId },
        timing: { occurredAt: stored.occurredAt, recordedAt: stored.recordedAt },
      }),
    );
  }

  function subscriptionsFor(services: ReturnType<typeof channelsModule.createServices>) {
    const subscriptions = channelsModule.buildSubscriptions?.(services) ?? [];
    const inventoryProjection = subscriptions.find(
      (entry) => entry.sourceContextName === "inventory" && entry.handlerKind === "projection",
    );
    const inventoryReaction = subscriptions.find(
      (entry) => entry.sourceContextName === "inventory" && entry.handlerKind === "reaction",
    );
    const channelsReaction = subscriptions.find(
      (entry) =>
        entry.sourceContextName === "channels" &&
        entry.handlerKind === "reaction" &&
        entry.projectionName === "channel-listing-desired-state-reaction",
    );
    if (!inventoryProjection || !inventoryReaction || !channelsReaction) {
      throw new Error("Channel allocation subscription wiring is incomplete.");
    }
    return { inventoryProjection, inventoryReaction, channelsReaction };
  }

  function createRunners(subscriptions: ReturnType<typeof subscriptionsFor>) {
    return {
      inventoryProjection: createSubscriptionRunner(
        "channels",
        pools.channels,
        pools.inventory,
        subscriptions.inventoryProjection,
      ),
      inventoryReaction: createSubscriptionRunner(
        "channels",
        pools.channels,
        pools.inventory,
        subscriptions.inventoryReaction,
      ),
      channelsReaction: createSubscriptionRunner(
        "channels",
        pools.channels,
        pools.channels,
        subscriptions.channelsReaction,
      ),
    };
  }

  async function drainAllocationPipeline(runners: ReturnType<typeof createRunners>) {
    await drain(runners.inventoryProjection);
    await drain(runners.inventoryReaction);
    await drain(runners.channelsReaction);
  }

  async function setAllocation(
    allocations: ReturnType<typeof inventoryModule.createServices>["channelStockAllocations"],
    expectedVersion: number,
    partitions: readonly Readonly<{ channelConnectionId: string; units: number }>[],
  ) {
    await expect(
      allocations.set(
        {
          accountId: "account-synthetic",
          inventoryItemId: "item-target",
          mode: "partitioned",
          partitions,
          expectedRevision: expectedVersion,
        },
        context,
      ),
    ).resolves.toMatchObject({ kind: "applied", allocation: { revision: expectedVersion + 1 } });
  }
});

async function drain(runner: ReturnType<typeof createSubscriptionRunner>) {
  while ((await runner.runOnce()).processed > 0) {
    // Drain the complete bounded synthetic fixture through production subscription wiring.
  }
}

async function seedInitialDesiredStates(
  services: ReturnType<typeof channelsModule.createServices>["listingComposition"],
) {
  for (const [connectionId, listingId, accountId] of [
    ["connection-a", "listing-target", "account-synthetic"],
    ["connection-b", "listing-target", "account-synthetic"],
    ["connection-control", "listing-control", "account-control"],
  ] as const) {
    await services.recordChannelListingDesiredState(
      { connectionId, listingId },
      {
        ...context,
        audit: { ...context.audit, forAccountId: accountId as never },
      },
    );
  }
}

async function desiredStates(pool: PgTransactionalPool) {
  const result = await pool.query<{
    payload: { connectionId: string; listingId: string; draft?: { quantity?: number } };
  }>(
    `SELECT payload FROM event_store_events
     WHERE event_type='channels.channel-listing.desired-state-changed'
     ORDER BY global_position`,
  );
  return result.rows.map(({ payload }) => ({
    connectionId: payload.connectionId,
    listingId: payload.listingId,
    quantity: payload.draft?.quantity ?? null,
  }));
}

async function seedCompositionFacts(pool: PgTransactionalPool) {
  const selectedOptions = [{ dimensionId: "condition", optionId: "near-mint" }];
  const selectedOptionKey = deriveChannelSelectedOptionKey(selectedOptions);
  await pool.query(
    `INSERT INTO channels_connection_facts
       (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     VALUES
       ('connection-a','account-synthetic','synthetic-provider','sandbox','active',now(),2),
       ('connection-b','account-synthetic','synthetic-provider','sandbox','active',now(),2),
       ('connection-control','account-control','synthetic-provider','sandbox','active',now(),2)`,
  );
  await pool.query(
    `INSERT INTO channels_connection_publication_settings
       (connection_id,title_prefix,title_suffix,description_footer,category_allowlist,excluded_listing_ids,updated_at,last_stream_version)
     SELECT connection_id,'','','','["cards"]'::jsonb,'[]'::jsonb,now(),1 FROM channels_connection_facts`,
  );
  await pool.query(
    `INSERT INTO channels_listing_publication_facts
       (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
        selected_options,selected_option_key,listing_status,pause_reason,item_title,item_subtitle,product_summary,graded_card,
        updated_at,listing_stream_version)
     VALUES
       ('listing-target','account-synthetic','item-target','catalog-target','20.00','USD',100,$1::jsonb,$2,'active',NULL,
        'Synthetic target card',NULL,'Synthetic target description',NULL,now(),2),
       ('listing-control','account-control','item-control','catalog-control','30.00','USD',100,$1::jsonb,$2,'active',NULL,
        'Synthetic control card',NULL,'Synthetic control description',NULL,now(),2)`,
    [JSON.stringify(selectedOptions), selectedOptionKey],
  );
  await pool.query(
    `INSERT INTO channels_inventory_item_facts
       (item_id,account_id,catalog_item_id,total_quantity,updated_at,item_stream_version)
     VALUES ('item-target','account-synthetic','catalog-target',10,now(),1),
            ('item-control','account-control','catalog-control',8,now(),1)`,
  );
  await pool.query(
    `INSERT INTO channels_catalog_item_category_facts
       (catalog_item_id,category_id,assigned,updated_at,catalog_item_stream_version)
     VALUES ('catalog-target','cards',true,now(),1),('catalog-control','cards',true,now(),1)`,
  );
  await pool.query(
    `INSERT INTO channels_external_product_reference_facts
       (provider_key,external_key,catalog_item_id,selected_options,selected_option_key,link_state,updated_at,reference_stream_version)
     VALUES ('synthetic-provider','sku:target','catalog-target',$1::jsonb,$2,'linked',now(),1),
            ('synthetic-provider','sku:control','catalog-control',$1::jsonb,$2,'linked',now(),1)`,
    [JSON.stringify(selectedOptions), selectedOptionKey],
  );
  await pool.query(
    `INSERT INTO channels_external_catalog_item_reference_facts
       (provider_key,external_key,catalog_item_id,link_state,updated_at,reference_stream_version)
     VALUES ('synthetic-provider','product:target','catalog-target','linked',now(),1),
            ('synthetic-provider','product:control','catalog-control','linked',now(),1)`,
  );
  await pool.query(
    `INSERT INTO channels_channel_mappings
       (connection_id,dimension,source_key,target_key,confidence_tier,review_status,provenance,evidence,updated_at,last_stream_version)
     SELECT connection_id,dimension,source_key,target_key,'manual','accepted','operator',
       '{"listingId":"listing-synthetic","derivedFrom":"synthetic-allocation-proof"}'::jsonb,now(),1
     FROM channels_connection_facts
     CROSS JOIN (VALUES
       ('category','catalog-category:cards','trading-cards'),
       ('condition','selected-option:condition:near-mint','near-mint')
     ) AS mapping(dimension,source_key,target_key)`,
  );
}
