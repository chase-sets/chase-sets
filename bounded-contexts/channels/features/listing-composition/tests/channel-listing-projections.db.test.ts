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
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import {
  buildChannelCatalogFactsProjectionHandlers,
  buildChannelInventoryFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "../read-model/facts-projection";
import { readChannelPublicationConnection, resolveChannelPublishableQuantity } from "../read-model/queries";
import { channelListingCompositionSchemaMigrations, channelListingCompositionTableNames } from "../read-model/schema";
import { buildChannelListingStateProjectionHandlers } from "../read-model/state-projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-projection-concurrent-write", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_listing_composition");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("publish_quantity_cap migration and read-back upgrades the previous schema and round-trips null and 2", async () => {
    await resetMultiContextTestSchemas(pools);
    const migrationId = "20261003_channels_connection_publish_quantity_cap";
    if (!channelsModule.schemaMigrations) throw new Error("Channels migrations are required.");
    const previousModule = {
      ...channelsModule,
      schemaSql: channelsModule.schemaSql.replace("    publish_quantity_cap integer NULL,\n", ""),
      schemaMigrations: channelsModule.schemaMigrations
        .filter((migration) => migration.migrationId !== migrationId)
        .map((migration) => ({
          ...migration,
          statements: migration.statements.map((statement) =>
            statement.replace("    publish_quantity_cap integer NULL,\n", ""),
          ),
        })),
    };
    await bootstrapContextDatabase(previousModule, pools.channels);
    const columns = () =>
      pools.channels.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='channels_connection_publication_settings' AND column_name='publish_quantity_cap'",
      );
    expect((await columns()).rows).toEqual([]);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect((await columns()).rows).toEqual([{ column_name: "publish_quantity_cap" }]);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    const migration = channelListingCompositionSchemaMigrations.find((entry) => entry.migrationId === migrationId)!;
    for (const statement of migration.statements) await pools.channels.query(statement);
    await pools.channels.query(
      `INSERT INTO channels_connection_facts (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
       VALUES ('connection-1','account-1','synthetic-provider','sandbox','active',now(),1),
              ('connection-other','account-1','synthetic-provider','sandbox','active',now(),1)`,
    );
    const marketplace = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    const inventory = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    const state = buildChannelListingStateProjectionHandlers(pools.channels);
    await marketplace["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing-1",
          accountId: "account-1",
          inventoryItemId: "item-1",
          catalogItemId: "catalog-1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 10,
          selectedOptions: [],
          itemTitle: "Synthetic card",
          itemSubtitle: null,
          productSummary: null,
          gradedCard: null,
        },
        "marketplace.listing-listing-1",
        1,
      ),
    );
    await inventory["inventory.item.created"]!(
      event(
        "inventory.item.created",
        {
          itemId: "item-1",
          accountId: "account-1",
          catalogItemId: "catalog-1",
          totalQuantity: 10,
        },
        "inventory.item-item-1",
        1,
      ),
    );
    let version = 0;
    for (const publishQuantityCap of [null, 2, null]) {
      version += 1;
      await state["channels.channel-publication-configuration.settings-replaced"]!(
        event(
          "channels.channel-publication-configuration.settings-replaced",
          {
            connectionId: "connection-1",
            settings: {
              titlePrefix: "",
              titleSuffix: "",
              descriptionFooter: "",
              categoryAllowlist: [],
              excludedListingIds: [],
              publishQuantityCap,
            },
          },
          "channels.channel-publication-configuration-connection-1",
          version,
        ),
      );
      expect(
        (
          await readChannelPublicationConnection(pools.channels, {
            accountId: "account-1",
            connectionId: "connection-1",
          })
        )?.settings?.publishQuantityCap,
      ).toBe(publishQuantityCap);
      await expect(
        resolveChannelPublishableQuantity(pools.channels, { connectionId: "connection-1", listingId: "listing-1" }),
      ).resolves.toEqual({ kind: "resolved", publishableQuantity: publishQuantityCap ?? 10 });
      await expect(
        resolveChannelPublishableQuantity(pools.channels, { connectionId: "connection-other", listingId: "listing-1" }),
      ).resolves.toEqual({ kind: "resolved", publishableQuantity: 10 });
      await expect(resolveChannelPublishableQuantity(pools.channels, { listingId: "listing-1" })).resolves.toEqual({
        kind: "resolved",
        publishableQuantity: 10,
      });
    }
  });

  it("channel-publishable-quantity-availability preserves actual stock and active holds", async () => {
    const marketplace = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    const inventory = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    await marketplace["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing-1",
          accountId: "account-1",
          inventoryItemId: "item-1",
          catalogItemId: "catalog-1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 10,
          selectedOptions: [],
          itemTitle: "Card",
          itemSubtitle: null,
          productSummary: null,
          gradedCard: null,
        },
        "marketplace.listing-listing-1",
        1,
      ),
    );
    await inventory["inventory.item.created"]!(
      event(
        "inventory.item.created",
        {
          itemId: "item-1",
          accountId: "account-1",
          catalogItemId: "catalog-1",
          totalQuantity: 4,
        },
        "inventory.item-item-1",
        1,
      ),
    );
    await inventory["inventory.hold.placed"]!(
      event(
        "inventory.hold.placed",
        {
          holdId: "hold-1",
          itemId: "item-1",
          quantity: 1,
        },
        "inventory.hold-hold-1",
        1,
      ),
    );
    await expect(resolveChannelPublishableQuantity(pools.channels, { listingId: "listing-1" })).resolves.toEqual({
      kind: "resolved",
      publishableQuantity: 3,
    });
    await inventory["inventory.item.adjusted"]!(
      event(
        "inventory.item.adjusted",
        {
          itemId: "item-1",
          quantityDelta: -2,
        },
        "inventory.item-item-1",
        2,
      ),
    );
    await expect(resolveChannelPublishableQuantity(pools.channels, { listingId: "listing-1" })).resolves.toEqual({
      kind: "resolved",
      publishableQuantity: 1,
    });
    await inventory["inventory.hold.placed"]!(
      event(
        "inventory.hold.placed",
        {
          holdId: "hold-2",
          itemId: "item-1",
          quantity: 1,
        },
        "inventory.hold-hold-2",
        1,
      ),
    );
    await expect(resolveChannelPublishableQuantity(pools.channels, { listingId: "listing-1" })).resolves.toEqual({
      kind: "resolved",
      publishableQuantity: 0,
    });
    await inventory["inventory.hold.released"]!(
      event(
        "inventory.hold.released",
        {
          holdId: "hold-2",
        },
        "inventory.hold-hold-2",
        2,
      ),
    );
    await expect(resolveChannelPublishableQuantity(pools.channels, { listingId: "listing-1" })).resolves.toEqual({
      kind: "resolved",
      publishableQuantity: 1,
    });
  });

  it("R1 rejects the quantity-event price-pair overwrite mutant", async () => {
    const handlers = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    await handlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing-1",
          accountId: "account-1",
          inventoryItemId: "item-1",
          catalogItemId: "catalog-1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 10,
          selectedOptions: [],
          itemTitle: "Card",
          itemSubtitle: null,
          productSummary: null,
          gradedCard: null,
        },
        "marketplace.listing-listing-1",
        1,
      ),
    );
    await handlers["marketplace.listing.price-updated"]!(
      event(
        "marketplace.listing.price-updated",
        {
          priceAmount: "20.00",
          priceCurrencyCode: "EUR",
        },
        "marketplace.listing-listing-1",
        2,
      ),
    );
    await handlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing-1",
          accountId: "account-1",
          inventoryItemId: "item-1",
          catalogItemId: "catalog-1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 10,
          selectedOptions: [],
          itemTitle: "Card",
          itemSubtitle: null,
          productSummary: null,
          gradedCard: null,
        },
        "marketplace.listing-listing-1",
        1,
      ),
    );
    await handlers["marketplace.listing.quantity-cap-updated"]!(
      event("marketplace.listing.quantity-cap-updated", { quantityCap: 5 }, "marketplace.listing-listing-1", 3),
    );
    const result = await pools.channels.query<{
      price_amount: string;
      price_currency_code: string;
      quantity_cap: number;
      listing_stream_version: string;
    }>(
      `SELECT price_amount,price_currency_code,quantity_cap,listing_stream_version::text
       FROM channels_listing_publication_facts WHERE listing_id='listing-1'`,
    );
    expect(result.rows[0]).toEqual({
      price_amount: "20.00",
      price_currency_code: "EUR",
      quantity_cap: 5,
      listing_stream_version: "3",
    });
  });

  it("channel-catalog-facts-replay-safety retains category and both reference tombstones", async () => {
    const handlers = buildChannelCatalogFactsProjectionHandlers(pools.channels);
    const catalogStream = "catalog.item-catalog-1";
    await handlers["catalog.catalog-item.category-assigned"]!(
      event("catalog.catalog-item.category-assigned", { categoryId: "cards" }, catalogStream, 7),
    );
    await handlers["catalog.catalog-item.category-removed"]!(
      event("catalog.catalog-item.category-removed", { categoryId: "cards" }, catalogStream, 8),
    );
    await handlers["catalog.catalog-item.category-assigned"]!(
      event("catalog.catalog-item.category-assigned", { categoryId: "cards" }, catalogStream, 7),
    );
    for (const family of ["product", "catalog-item"] as const) {
      const linked = `catalog.catalog-item.external-${family}-reference-linked`;
      const unlinked = `catalog.catalog-item.external-${family}-reference-unlinked`;
      const payload =
        family === "product"
          ? { providerKey: "synthetic-provider", externalKey: "sku:1", selectedOptions: [] }
          : { providerKey: "synthetic-provider", externalKey: "product:1" };
      await handlers[linked]!(event(linked, payload, catalogStream, 7));
      await handlers[unlinked]!(event(unlinked, payload, catalogStream, 8));
      await handlers[linked]!(event(linked, payload, catalogStream, 7));
    }
    const category = await pools.channels.query<{ assigned: boolean; catalog_item_stream_version: string }>(
      `SELECT assigned,catalog_item_stream_version::text FROM channels_catalog_item_category_facts`,
    );
    const references = await pools.channels.query<{ link_state: string; reference_stream_version: string }>(
      `SELECT link_state,reference_stream_version::text FROM channels_external_product_reference_facts
       UNION ALL SELECT link_state,reference_stream_version::text FROM channels_external_catalog_item_reference_facts`,
    );
    expect(category.rows).toEqual([{ assigned: false, catalog_item_stream_version: "8" }]);
    expect(references.rows).toEqual([
      { link_state: "unlinked", reference_stream_version: "8" },
      { link_state: "unlinked", reference_stream_version: "8" },
    ]);
  });

  it("keeps boot SQL and migration ownership aligned for every registered projection and operation fence", async () => {
    const result = await pools.channels.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[]) ORDER BY tablename`,
      [channelListingCompositionTableNames],
    );
    expect(result.rows.map((row) => row.tablename)).toEqual([...channelListingCompositionTableNames].sort());
    await bootstrapContextDatabase(channelsModule, pools.channels);
    const second = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[])`,
      [channelListingCompositionTableNames],
    );
    expect(second.rows[0]?.count).toBe(String(channelListingCompositionTableNames.length));
  });
});

function event(type: string, data: Record<string, unknown>, streamId: string, streamVersion: number) {
  return buildTransportEvent(type, data, { streamId, streamVersion, globalPosition: `${streamId}:${streamVersion}` });
}
