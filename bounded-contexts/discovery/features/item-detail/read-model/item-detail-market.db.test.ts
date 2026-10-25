import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { module as discoveryModule } from "../../../index";
import { getDiscoveryItemDetail } from "./queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for item-detail market DB tests in CI.");
}
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Discovery item-detail market ordering and product facts on Postgres", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["discovery"], "item_detail_market");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).discovery;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ discovery: pool });
    await pool.query(realtimeOutboxSchemaSql);
    await bootstrapContextDatabase(discoveryModule, pool);
    await pool.query(`
      INSERT INTO discovery_market_accounts
        (account_id, seller_slug, seller_display_name, status, seller_listing_availability_status)
      VALUES ('acc_seller', 'seller', 'Seller', 'active', 'available'),
             ('acc_buyer', 'buyer', 'Buyer', 'active', 'available');
      INSERT INTO discovery_item_detail_pages (catalog_item_id, slug, title, status, product_schema)
      VALUES ('cat_market', 'market-item', 'Market item', 'published', '{}'::jsonb);
    `);
  });

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  it("keeps the canonical boundary order, guards invalid prices, and returns out-of-window product facts", async () => {
    const normalListings = Array.from({ length: 23 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return `('listing_${number}', 'listing-${number}', 'market-item', 'acc_seller', 'inv_${number}', 'cat_market', 'product_${number}',
         'Market item', '10.00', 'USD', 1, 1, 1, 0, '{}'::jsonb, 'active',
         '2026-01-01T00:00:${number}.000Z', '2026-02-01T00:00:${number}.000Z')`;
    }).join(",\n");

    await pool.query(`
      INSERT INTO discovery_market_listings
        (listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id,
         product_id, item_title, price_amount, price_currency_code, listing_stream_version, quantity_cap,
         supply_total_quantity, active_held_quantity, product_measure_snapshot, status, created_at, updated_at)
      VALUES
        ${normalListings},
        ('listing_tie_old', 'tie-old', 'market-item', 'acc_seller', 'inv_tie_old', 'cat_market', 'product_tie',
         'Market item', '10.00', 'USD', 1, 1, 1, 0, '{}'::jsonb, 'active',
         '2026-01-01T00:00:23.000Z', '2026-02-01T00:00:01.000Z'),
        ('listing_tie_new', 'tie-new', 'market-item', 'acc_seller', 'inv_tie_new', 'cat_market', 'product_tie',
         'Market item', '10.00', 'USD', 1, 1, 1, 0, '{}'::jsonb, 'active',
         '2026-01-01T00:00:24.000Z', '2026-02-01T00:00:02.000Z'),
        ('listing_outside', 'outside', 'market-item', 'acc_seller', 'inv_outside', 'cat_market', 'product_outside',
         'Market item', '99.00', 'USD', 1, 1, 1, 0, '{}'::jsonb, 'active',
         '2026-01-01T00:00:25.000Z', '2026-02-01T00:00:25.000Z'),
        ('listing_eur_valid', 'eur-valid', 'market-item', 'acc_seller', 'inv_eur_valid', 'cat_market', 'product_eur',
         'Market item', '1.00', 'ZZZ', 1, 1, 1, 0, '{}'::jsonb, 'active',
         '2026-01-01T00:00:26.000Z', '2026-02-01T00:00:26.000Z'),
        ('listing_eur_invalid', 'eur-invalid', 'market-item', 'acc_seller', 'inv_eur_invalid', 'cat_market', 'product_invalid',
         'Market item', 'abc', 'ZZZ', 1, 1, 1, 0, '{}'::jsonb, 'active',
         '2026-01-01T00:00:27.000Z', '2026-02-01T00:00:27.000Z');

      INSERT INTO discovery_offer_demand_matches
        (offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title, price_amount,
         price_currency_code, offer_stream_version, quantity_requested, status, created_at, updated_at)
      VALUES
        ('offer_low', 'acc_buyer', 'cat_market', 'product_outside', 'Market item', '5.00', 'USD', 1, 1, 'submitted',
         '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
        ('offer_best', 'acc_buyer', 'cat_market', 'product_outside', 'Market item', '7.00', 'USD', 1, 2, 'submitted',
         '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z');
    `);

    const detail = await getDiscoveryItemDetail(pool, "market-item");

    expect(detail).not.toBeNull();
    expect(detail!.market_listings).toHaveLength(25);
    expect(detail!.market_listings.map((listing) => listing.listing_id)).toContain("listing_tie_old");
    expect(detail!.market_listings.map((listing) => listing.listing_id)).not.toContain("listing_tie_new");
    expect(detail!.market_products ?? []).toEqual(
      expect.arrayContaining([
        { product_id: "product_outside", lowest_listing_id: "listing_outside", best_offer_id: "offer_best" },
        { product_id: "product_invalid", lowest_listing_id: null, best_offer_id: null },
      ]),
    );
    expect((detail!.market_product_listings ?? []).map((listing) => listing.listing_id)).toContain("listing_outside");
    expect((detail!.market_product_listings ?? []).map((listing) => listing.listing_id)).toContain(
      "listing_eur_invalid",
    );
    expect((detail!.market_product_listings ?? []).map((listing) => listing.listing_id)).toContain("listing_eur_valid");
    expect(detail!.market_summary).not.toBeNull();
  });

  it("returns empty market arrays when the item has no visible rows", async () => {
    const detail = await getDiscoveryItemDetail(pool, "market-item");

    expect(detail?.market_listings).toEqual([]);
    expect(detail?.offer_demand_matches).toEqual([]);
    expect(detail?.market_products).toEqual([]);
    expect(detail?.market_product_listings).toEqual([]);
  });
});
