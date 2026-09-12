import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapPlatformControlPlane(pools.control);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

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

    await expect(runner!.runOnce()).resolves.toMatchObject({ processed: 1 });
    await expect(
      services.reconciliation.readChannelReconciliationMetrics({
        accountId: "account-1",
        connectionId: "connection-1",
        window: { from: "2026-09-11T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z" },
      }),
    ).resolves.toMatchObject({
      runsCompleted: 1,
      counts: { listingsReconciled: 3, repairable: 1, foreignEdit: 1, structural: 1, repairsEnqueued: 1 },
    });
    await expect(
      services.reconciliation.readChannelDriftAttentionContribution({ connectionId: "connection-1" }),
    ).resolves.toMatchObject({ affectedListingCount: 2, hasMore: 0, resolution: null });
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
});

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

function syntheticRegistry() {
  const observed: readonly ChannelStateLineV1[] = [
    state("external-repairable", "6", 900, 1, fingerprint("a")),
    state("external-foreign", "foreign", 1_200, 1, fingerprint("b")),
  ];
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
        publishListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
        updatePriceQuantity: async () => ({ kind: "succeeded", externalListingId: "unused" }),
        delistListing: async () => ({ kind: "succeeded", externalListingId: "unused" }),
        fetchChannelState: async () => ({
          kind: "complete",
          items: observed,
          collectedCount: observed.length,
          authorityTotal: observed.length,
          pageCount: 1,
        }),
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
