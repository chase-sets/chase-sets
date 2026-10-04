import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as channelsModule } from "../../../index";
import { createChannelCompositionProfileRegistry } from "../domain/canonical";
import { channelPublicationConfigurationEventCodec } from "../domain/codecs";
import { createChannelListingCompositionRuntime } from "../api/runtime";
import { testContext } from "../../connections/tests/test-support";
import { buildChannelOwnedDesiredStateReactionHandlers } from "../integrations/reactions";
import {
  buildChannelInventoryFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "../read-model/facts-projection";
import { buildChannelListingStateProjectionHandlers } from "../read-model/state-projection";
import type { ChannelListingDesiredStateChangedData } from "../domain/contracts";
import { syntheticProfile } from "./test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-publication-configuration-commands real DB", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels"],
      "channel_publication_configuration",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await pools.channels.query(
      `INSERT INTO channels_connection_facts
       (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
       VALUES ('connection-1','account-1','synthetic-provider','sandbox','active',now(),1)`,
    );
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("publish quantity cap replacement updates only changed published quantities and unchanged saves enqueue nothing", async () => {
    const services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry([
        {
          ...syntheticProfile,
          requiresProviderProductReference: false,
          requiresProviderCatalogItemReference: false,
          category: { mode: "snapshot-preserved", maxKeyLength: 100, snapshotField: "category" },
          condition: { mode: "snapshot-preserved", maxKeyLength: 100, snapshotField: "condition" },
        },
      ]),
    });
    const marketplace = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    const inventory = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    const projection = buildChannelListingStateProjectionHandlers(pools.channels);
    const reactions = buildChannelOwnedDesiredStateReactionHandlers(services, {
      enqueueDesiredState: async () => null,
    });
    let cursor = "0";
    async function drain() {
      for (let pass = 0; pass < 20; pass += 1) {
        const rows = await pools.channels.query<{
          event_type: string;
          payload: Record<string, unknown>;
          stream_id: string;
          stream_version: string | number;
          global_position: string;
        }>(
          "SELECT event_type,payload,stream_id,stream_version,global_position::text FROM event_store_events AS events WHERE events.global_position > $1::bigint ORDER BY events.global_position LIMIT 100",
          [cursor],
        );
        if (rows.rows.length === 0) return;
        for (const row of rows.rows) {
          const event = buildTransportEvent(row.event_type, row.payload, {
            streamId: row.stream_id,
            streamVersion: Number(row.stream_version),
            globalPosition: row.global_position,
          });
          await projection[row.event_type]?.(event);
          if (
            row.event_type === "channels.channel-publication-configuration.settings-replaced" ||
            row.event_type.startsWith("channels.channel-listing-reconciliation.")
          )
            await reactions[row.event_type]?.(event);
          cursor = row.global_position;
        }
      }
      throw new Error("Synthetic reconciliation did not settle.");
    }
    for (const [listingId, totalQuantity] of [
      ["listing-4", 4],
      ["listing-1", 1],
    ] as const) {
      await marketplace["marketplace.listing.created"]!(
        buildTransportEvent(
          "marketplace.listing.created",
          {
            listingId,
            accountId: "account-1",
            inventoryItemId: `item-${listingId}`,
            catalogItemId: "catalog-1",
            priceAmount: "20.00",
            priceCurrencyCode: "USD",
            quantityCap: 10,
            selectedOptions: [],
            itemTitle: "Synthetic card",
            itemSubtitle: null,
            productSummary: "Synthetic description",
            gradedCard: null,
          },
          { streamId: `marketplace.listing-${listingId}`, streamVersion: 1 },
        ),
      );
      await marketplace["marketplace.listing.published"]!(
        buildTransportEvent(
          "marketplace.listing.published",
          {},
          { streamId: `marketplace.listing-${listingId}`, streamVersion: 2 },
        ),
      );
      await inventory["inventory.item.created"]!(
        buildTransportEvent(
          "inventory.item.created",
          {
            itemId: `item-${listingId}`,
            accountId: "account-1",
            catalogItemId: "catalog-1",
            totalQuantity,
          },
          { streamId: `inventory.item-item-${listingId}`, streamVersion: 1 },
        ),
      );
    }
    const settings = {
      titlePrefix: "",
      titleSuffix: "",
      descriptionFooter: "",
      categoryAllowlist: [],
      excludedListingIds: [],
      publishQuantityCap: null,
    };
    await expect(
      services.replaceChannelConnectionPublicationSettings(
        { accountId: "account-1", connectionId: "connection-1", settings, expectedStreamVersion: 0 },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 1 });
    await drain();
    const initial = await pools.channels.query<{ payload: ChannelListingDesiredStateChangedData }>(
      "SELECT payload FROM event_store_events WHERE event_type='channels.channel-listing.desired-state-changed' ORDER BY global_position",
    );
    expect(initial.rows).toHaveLength(2);
    for (const { payload } of initial.rows) {
      if (payload.intent === "delist") throw new Error("Expected a publish draft.");
      await expect(
        services.recordChannelListingPublicationOutcome(
          {
            connectionId: payload.connectionId,
            channelListingId: payload.channelListingId,
            operationId: `synthetic-${payload.listingId}`,
            reportedDesiredStateSequence: payload.desiredStateSequence,
            reportedListingRevision: payload.listingRevision,
            reportedDesiredStateHash: payload.desiredStateHash,
            expectedStreamVersion: payload.desiredStateSequence,
            outcome: { kind: "succeeded", externalListingId: `external-${payload.listingId}` },
          },
          testContext,
        ),
      ).resolves.toMatchObject({ kind: "applied" });
    }
    await drain();
    expect(
      (
        await pools.channels.query(
          "SELECT last_pushed_quantity FROM channels_channel_listing_links WHERE listing_id='listing-4' AND publish_state='published'",
        )
      ).rows,
    ).toEqual([{ last_pushed_quantity: 4 }]);
    const capped = { ...settings, publishQuantityCap: 2 };
    await expect(
      services.replaceChannelConnectionPublicationSettings(
        { accountId: "account-1", connectionId: "connection-1", settings: capped, expectedStreamVersion: 1 },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 2 });
    await drain();
    const updates = await pools.channels.query<{ payload: ChannelListingDesiredStateChangedData }>(
      "SELECT payload FROM event_store_events WHERE event_type='channels.channel-listing.desired-state-changed' AND payload->>'intent'='update'",
    );
    expect(updates.rows).toHaveLength(1);
    expect(updates.rows[0]?.payload).toMatchObject({
      listingId: "listing-4",
      intent: "update",
      draft: { quantity: 2 },
    });
    const beforeSave = await pools.channels.query(
      "SELECT event_type,count(*)::text AS count FROM event_store_events GROUP BY event_type ORDER BY event_type",
    );
    await expect(
      services.replaceChannelConnectionPublicationSettings(
        { accountId: "account-1", connectionId: "connection-1", settings: capped, expectedStreamVersion: 2 },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "unchanged", streamVersion: 2 });
    await drain();
    expect(
      (
        await pools.channels.query(
          "SELECT event_type,count(*)::text AS count FROM event_store_events GROUP BY event_type ORDER BY event_type",
        )
      ).rows,
    ).toEqual(beforeSave.rows);
  });

  it("keeps versioned settings and review decisions idempotent and enqueues once per successful append", async () => {
    const services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry(),
    });
    const settings = {
      titlePrefix: "",
      titleSuffix: "",
      descriptionFooter: "",
      categoryAllowlist: ["cards"],
      excludedListingIds: [],
      publishQuantityCap: null,
    };
    await expect(
      services.replaceChannelConnectionPublicationSettings(
        {
          accountId: "account-1",
          connectionId: "connection-1",
          settings,
          expectedStreamVersion: 0,
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 1 });
    await expect(
      services.replaceChannelConnectionPublicationSettings(
        {
          accountId: "account-1",
          connectionId: "connection-1",
          settings,
          expectedStreamVersion: 1,
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "unchanged", streamVersion: 1 });
    await expect(
      services.recordChannelMappingCandidates(
        {
          connectionId: "connection-1",
          provenance: "compose-discovered",
          candidates: [
            {
              dimension: "category",
              sourceKey: "catalog-category:cards",
              proposedTargetKey: "trading-cards",
              confidenceTier: "high",
              evidence: { listingId: "listing-1", derivedFrom: "assigned category cards" },
            },
          ],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 2 });
    await expect(
      services.recordChannelMappingCandidates(
        {
          connectionId: "connection-1",
          provenance: "export-discovered",
          candidates: [
            {
              dimension: "category",
              sourceKey: "catalog-category:cards",
              proposedTargetKey: "other",
              confidenceTier: "low",
              evidence: { listingId: "listing-1", derivedFrom: "export row" },
            },
          ],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "unchanged", streamVersion: 2 });
    await expect(
      services.decideChannelMappingReview(
        {
          accountId: "account-1",
          connectionId: "connection-1",
          dimension: "category",
          sourceKey: "catalog-category:cards",
          decision: "accept",
          targetKey: "trading-cards",
          expectedStreamVersion: 2,
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 3 });
    await expect(
      services.decideChannelMappingReview(
        {
          accountId: "account-1",
          connectionId: "connection-1",
          dimension: "category",
          sourceKey: "catalog-category:cards",
          decision: "reject",
          targetKey: null,
          expectedStreamVersion: 2,
        },
        testContext,
      ),
    ).resolves.toEqual({ kind: "refused", code: "stream-version-conflict" });
    const configurationEvents = await pools.channels.query<{
      event_type: string;
      payload: Record<string, unknown>;
      stream_id: string;
      stream_version: number;
      global_position: string;
    }>(
      `SELECT event_type,payload,stream_id,stream_version,global_position::text
       FROM event_store_events WHERE event_type LIKE 'channels.channel-publication-configuration.%'
       ORDER BY stream_version`,
    );
    const reactions = buildChannelOwnedDesiredStateReactionHandlers(services, {
      enqueueDesiredState: async () => null,
    });
    for (const event of configurationEvents.rows) {
      expect(() =>
        channelPublicationConfigurationEventCodec.decode({
          eventType: event.event_type,
          payload: event.payload as never,
        }),
      ).not.toThrow();
      await reactions[event.event_type]!(
        buildTransportEvent(event.event_type, event.payload, {
          streamId: event.stream_id,
          streamVersion: event.stream_version,
          globalPosition: event.global_position,
        }),
      );
    }
    const counts = await pools.channels.query<{ event_type: string; count: string }>(
      `SELECT event_type,COUNT(*)::text AS count FROM event_store_events
       WHERE event_type LIKE 'channels.channel-publication-configuration.%'
          OR event_type='channels.channel-listing-reconciliation.run-enqueued'
       GROUP BY event_type ORDER BY event_type`,
    );
    expect(counts.rows).toEqual([
      { event_type: "channels.channel-listing-reconciliation.run-enqueued", count: "3" },
      { event_type: "channels.channel-publication-configuration.mapping-candidate-recorded", count: "1" },
      { event_type: "channels.channel-publication-configuration.mapping-review-decided", count: "1" },
      { event_type: "channels.channel-publication-configuration.settings-replaced", count: "1" },
    ]);

    await expect(
      services.replaceChannelConnectionPublicationSettings(
        {
          accountId: "account-foreign",
          connectionId: "connection-1",
          settings,
          expectedStreamVersion: 3,
        },
        testContext,
      ),
    ).resolves.toEqual({ kind: "refused", code: "unknown-link" });
    const afterForeign = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_store_events
       WHERE event_type LIKE 'channels.channel-publication-configuration.%'`,
    );
    expect(afterForeign.rows[0]?.count).toBe("3");
  });

  it("R9 rejects command/event validator drift mutants before append", async () => {
    const services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry(),
    });
    const invalidCalls = [
      () =>
        services.replaceChannelConnectionPublicationSettings(
          {
            accountId: "account-1",
            connectionId: "connection-1",
            expectedStreamVersion: 0,
            settings: {
              titlePrefix: "",
              titleSuffix: "",
              descriptionFooter: "",
              categoryAllowlist: [],
              excludedListingIds: [],
              intruder: true,
            },
          } as never,
          testContext,
        ),
      () =>
        services.recordChannelMappingCandidates(
          {
            connectionId: "connection-1",
            provenance: "compose-discovered",
            candidates: [
              {
                dimension: "invented",
                sourceKey: "catalog-category:cards",
                proposedTargetKey: "cards",
                confidenceTier: "high",
                evidence: { listingId: "listing-1", derivedFrom: "synthetic" },
              },
            ],
          } as never,
          testContext,
        ),
      () =>
        services.recordChannelMappingCandidates(
          {
            connectionId: "connection-1",
            provenance: "compose-discovered",
            candidates: [
              {
                dimension: "category",
                sourceKey: "catalog-category:cards",
                proposedTargetKey: "cards",
                confidenceTier: "invented",
                evidence: { listingId: "listing-1", derivedFrom: "synthetic", intruder: true },
              },
            ],
          } as never,
          testContext,
        ),
      () =>
        services.decideChannelMappingReview(
          {
            accountId: "account-1",
            connectionId: "connection-1",
            dimension: "category",
            sourceKey: "catalog-category:cards",
            decision: "invented",
            targetKey: 42,
            expectedStreamVersion: 0,
          } as never,
          testContext,
        ),
    ];
    for (const invoke of invalidCalls) await expect(invoke()).rejects.toThrow();
    const events = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_store_events
       WHERE event_type LIKE 'channels.channel-publication-configuration.%'`,
    );
    expect(events.rows[0]?.count).toBe("0");
  });
});
