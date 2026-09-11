import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { createChannelListingCompositionRuntime } from "../api/runtime";
import { createChannelCompositionProfileRegistry } from "../domain/canonical";
import {
  buildChannelCatalogFactsProjectionHandlers,
  buildChannelConnectionFactsProjectionHandlers,
  buildChannelInventoryFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "../read-model/facts-projection";
import { buildChannelListingStateProjectionHandlers } from "../read-model/state-projection";
import { syntheticProfile } from "./test-support";
import { testContext } from "../../connections/tests/test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-listing-desired-state-production-path", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_desired_state_production");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("composes the landed Marketplace amount/currency pair once and advances on currency-only change", async () => {
    const marketplace = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    const inventory = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    const catalog = buildChannelCatalogFactsProjectionHandlers(pools.channels);
    const channels = {
      ...buildChannelConnectionFactsProjectionHandlers(pools.channels),
      ...buildChannelListingStateProjectionHandlers(pools.channels),
    };
    await marketplace["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing-production",
          accountId: "account-production",
          inventoryItemId: "item-production",
          catalogItemId: "catalog-production",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 10,
          selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
          itemTitle: "Production path card",
          itemSubtitle: null,
          productSummary: "Landed Marketplace pair",
          gradedCard: null,
        },
        "marketplace.listing-listing-production",
        1,
      ),
    );
    await marketplace["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-listing-production", 2),
    );
    await inventory["inventory.item.created"]!(
      event(
        "inventory.item.created",
        {
          itemId: "item-production",
          accountId: "account-production",
          catalogItemId: "catalog-production",
          totalQuantity: 4,
        },
        "inventory.item-item-production",
        1,
      ),
    );
    const catalogStream = "catalog.catalog-item-catalog-production";
    await catalog["catalog.catalog-item.category-assigned"]!(
      event("catalog.catalog-item.category-assigned", { categoryId: "cards" }, catalogStream, 1),
    );
    await catalog["catalog.catalog-item.external-product-reference-linked"]!(
      event(
        "catalog.catalog-item.external-product-reference-linked",
        {
          providerKey: "synthetic-provider",
          externalKey: "sku:production",
          selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        },
        catalogStream,
        2,
      ),
    );
    await catalog["catalog.catalog-item.external-catalog-item-reference-linked"]!(
      event(
        "catalog.catalog-item.external-catalog-item-reference-linked",
        { providerKey: "synthetic-provider", externalKey: "product:production" },
        catalogStream,
        3,
      ),
    );
    await channels["channels.connection.connected"]!(
      event(
        "channels.connection.connected",
        {
          connectionId: "connection-production",
          accountId: "account-production",
          providerKey: "synthetic-provider",
          environment: "sandbox",
        },
        "channels.connection-connection-production",
        1,
      ),
    );
    await channels["channels.connection.activated"]!(
      event(
        "channels.connection.activated",
        { connectionId: "connection-production" },
        "channels.connection-connection-production",
        2,
      ),
    );
    await channels["channels.channel-publication-configuration.settings-replaced"]!(
      event(
        "channels.channel-publication-configuration.settings-replaced",
        {
          connectionId: "connection-production",
          settings: {
            titlePrefix: "",
            titleSuffix: "",
            descriptionFooter: "",
            categoryAllowlist: ["cards"],
            excludedListingIds: [],
          },
        },
        "channels.channel-publication-configuration-connection-production",
        1,
      ),
    );
    await channels["channels.channel-publication-configuration.mapping-candidate-recorded"]!(
      event(
        "channels.channel-publication-configuration.mapping-candidate-recorded",
        {
          connectionId: "connection-production",
          provenance: "compose-discovered",
          candidates: [
            candidate("category", "catalog-category:cards", "trading-cards"),
            candidate("condition", "selected-option:condition:near-mint", "near-mint"),
          ],
        },
        "channels.channel-publication-configuration-connection-production",
        2,
      ),
    );
    for (const [version, dimension, sourceKey, targetKey] of [
      [3, "category", "catalog-category:cards", "trading-cards"],
      [4, "condition", "selected-option:condition:near-mint", "near-mint"],
    ] as const) {
      await channels["channels.channel-publication-configuration.mapping-review-decided"]!(
        event(
          "channels.channel-publication-configuration.mapping-review-decided",
          {
            connectionId: "connection-production",
            dimension,
            sourceKey,
            targetKey,
            confidenceTier: "manual",
            reviewStatus: "accepted",
            evidence: { listingId: "listing-production", derivedFrom: "production-path-fixture" },
          },
          "channels.channel-publication-configuration-connection-production",
          version,
        ),
      );
    }

    const services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry([syntheticProfile]),
    });
    const source = { connectionId: "connection-production", listingId: "listing-production" };
    const first = await services.recordChannelListingDesiredState(source, testContext);
    expect(first).toMatchObject({ kind: "applied", streamVersion: 1 });
    await projectLinkEvents(channels);
    const pending = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channels_channel_listing_links
       WHERE connection_id='connection-production' AND listing_id='listing-production' AND publish_state='pending'`,
    );
    expect(pending.rows[0]?.count).toBe("1");

    await marketplace["marketplace.listing.price-updated"]!(
      event(
        "marketplace.listing.price-updated",
        { priceAmount: "20.00", priceCurrencyCode: "EUR" },
        "marketplace.listing-listing-production",
        3,
      ),
    );
    await expect(services.recordChannelListingDesiredState(source, testContext)).resolves.toMatchObject({
      kind: "applied",
      streamVersion: 2,
    });
    const desired = await desiredEvents();
    expect(desired).toHaveLength(2);
    expect(desired.map((row) => row.payload.draft.price)).toEqual([
      { amountMinor: 2_000, currency: "USD" },
      { amountMinor: 2_000, currency: "EUR" },
    ]);
    expect(desired[0]!.payload.desiredStateHash).not.toBe(desired[1]!.payload.desiredStateHash);

    await marketplace["marketplace.listing.price-updated"]!(
      event(
        "marketplace.listing.price-updated",
        { priceAmount: "20.00", priceCurrencyCode: "EUR" },
        "marketplace.listing-listing-production",
        3,
      ),
    );
    await expect(services.recordChannelListingDesiredState(source, testContext)).resolves.toMatchObject({
      kind: "unchanged",
      streamVersion: 2,
    });
    expect(await desiredEvents()).toHaveLength(2);

    await marketplace["marketplace.listing.price-updated"]!(
      event("marketplace.listing.price-updated", { priceAmount: "21.00" }, "marketplace.listing-listing-production", 4),
    );
    await expect(services.recordChannelListingDesiredState(source, testContext)).resolves.toMatchObject({
      kind: "applied",
      streamVersion: 3,
    });
    const final = await pools.channels.query<{ event_type: string; payload: { reasons: readonly string[] } }>(
      `SELECT event_type,payload FROM event_store_events
       WHERE stream_id LIKE 'channels.channel-listing-cl_%' ORDER BY stream_version DESC LIMIT 1`,
    );
    expect(final.rows[0]).toMatchObject({
      event_type: "channels.channel-listing.publication-blocked",
      payload: { reasons: ["missing-price"] },
    });
  });
});

function candidate(dimension: string, sourceKey: string, proposedTargetKey: string) {
  return {
    dimension,
    sourceKey,
    proposedTargetKey,
    confidenceTier: "high",
    evidence: { listingId: "listing-production", derivedFrom: "production-path-fixture" },
  };
}

function event(type: string, data: Record<string, unknown>, streamId: string, streamVersion: number) {
  return buildTransportEvent(type, data, { streamId, streamVersion, globalPosition: `${streamId}:${streamVersion}` });
}

async function projectLinkEvents(
  handlers: ReturnType<typeof buildChannelListingStateProjectionHandlers>,
): Promise<void> {
  const rows = await pools.channels.query<{
    event_type: string;
    payload: Record<string, unknown>;
    stream_id: string;
    stream_version: number;
    global_position: string;
  }>(
    `SELECT event_type,payload,stream_id,stream_version,global_position::text
     FROM event_store_events WHERE stream_id LIKE 'channels.channel-listing-cl_%' ORDER BY stream_version`,
  );
  for (const row of rows.rows) {
    await handlers[row.event_type]!(
      buildTransportEvent(row.event_type, row.payload, {
        streamId: row.stream_id,
        streamVersion: Number(row.stream_version),
        globalPosition: row.global_position,
      }),
    );
  }
}

async function desiredEvents() {
  const rows = await pools.channels.query<{
    payload: Readonly<{
      desiredStateHash: string;
      draft: Readonly<{ price: Readonly<{ amountMinor: number; currency: string }> }>;
    }>;
  }>(
    `SELECT payload FROM event_store_events
     WHERE stream_id LIKE 'channels.channel-listing-cl_%'
       AND event_type='channels.channel-listing.desired-state-changed' ORDER BY stream_version`,
  );
  return rows.rows;
}
