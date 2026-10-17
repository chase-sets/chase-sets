import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { module as discoveryModule } from "../../index";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";
import { getDiscoveryPublicListingBySlug } from "./queries";
import {
  getDiscoveryItemDetail,
  getDiscoveryItemDetailSellerOverlay,
} from "../../features/item-detail/read-model/queries";
import { searchDiscoveryItems } from "../../features/search/read-model/queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Discovery parity DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Discovery Listing and Offer visibility parity on Postgres", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["discovery"], "listing_visibility_parity");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).discovery;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ discovery: pool });
    await pool.query(realtimeOutboxSchemaSql);
    await bootstrapContextDatabase(discoveryModule, pool);
    await pool.query(`
      INSERT INTO discovery_market_accounts (account_id, seller_slug, seller_display_name, status)
      VALUES ('acc_active', 'active', 'Active', 'active'), ('acc_suspended', 'suspended', 'Suspended', 'suspended'), ('acc_closed', 'closed', 'Closed', 'closed');
      INSERT INTO discovery_item_detail_pages (catalog_item_id, slug, title, status, product_schema)
      VALUES ('cat_one', 'item-one', 'Item', 'published', '{}'::jsonb);
      INSERT INTO discovery_search_items
        (catalog_item_id, slug, title, status, category_slugs, search_text, search_text_simple, dimension_filter_values)
      VALUES ('cat_one', 'item-one', 'Item', 'active', '["cards"]'::jsonb,
        to_tsvector('english', 'Item'), to_tsvector('simple', 'Item'),
        '[{"dimensionId":"finish","label":"Finish","optionId":"foil","optionLabel":"Foil"}]'::jsonb);
      INSERT INTO discovery_market_listings
        (listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         item_title, price_amount, price_currency_code, listing_stream_version, quantity_cap, supply_total_quantity,
         active_held_quantity, product_measure_snapshot, status)
      VALUES ('lst_seller', 'seller-listing', 'item-one', 'acc_active', 'inv_seller', 'cat_one', 'cat_one::', 'Item', '9.00', 'USD', 2, 1, 1, 0, '{}'::jsonb, 'active');
      INSERT INTO discovery_offer_demand_matches
        (offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title, price_amount, price_currency_code,
         offer_stream_version, quantity_requested, status)
      VALUES ('off_paused', 'acc_active', 'cat_one', 'cat_one::', 'Item', '8.00', 'USD', 1, 1, 'paused');
      INSERT INTO discovery_market_listings
        (listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         item_title, price_amount, price_currency_code, listing_stream_version, quantity_cap, supply_total_quantity,
         active_held_quantity, product_measure_snapshot, status)
      VALUES ('lst_active', 'active', 'item-one', 'acc_active', 'inv_active', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 1, 1, 0, '{}'::jsonb, 'active'),
             ('lst_suspended', 'suspended', 'item-one', 'acc_suspended', 'inv_suspended', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 1, 1, 0, '{}'::jsonb, 'active'),
             ('lst_closed', 'closed', 'item-one', 'acc_closed', 'inv_closed', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 1, 1, 0, '{}'::jsonb, 'active');
    `);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  it.each([
    ["active", true],
    ["suspended", false],
    ["closed", false],
    ["missing", false],
  ] as const)("runs every buyer Offer read and Listing counterpart for %s mirrors", async (slug, visible) => {
    const buyerAccountId = slug === "missing" ? "acc_missing" : `acc_${slug}`;
    await pool.query(
      `INSERT INTO discovery_offer_demand_matches
        (offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title, price_amount, price_currency_code,
         offer_stream_version, quantity_requested, status)
       VALUES ($1, $2, 'cat_one', 'cat_one::', 'Item', '8.00', 'USD', 1, 1, 'submitted')`,
      [`off_${slug}`, buyerAccountId],
    );
    const detail = await getDiscoveryItemDetail(pool, "item-one");
    const overlay = await getDiscoveryItemDetailSellerOverlay(pool, {
      accountId: "acc_active",
      catalogItemId: "cat_one",
    });
    const search = await searchDiscoveryItems(
      pool,
      {
        marketActivity: "offers",
        dimensionFilters: [{ dimensionId: "finish", optionId: "foil" }],
        includeTotal: true,
      },
      { loadFacets: true },
    );
    expect(detail?.offer_demand_matches.map((row) => row.offer_id)).toEqual(visible ? [`off_${slug}`] : []);
    expect(overlay.accountOfferMatches.map((row) => row.offer_id)).toEqual(visible ? [`off_${slug}`] : []);
    expect(search.total).toBe(visible ? 1 : 0);
    expect(
      search.facets.find((group) => group.id === "finish")?.values.find((value) => value.id === "foil")?.count ?? 0,
    ).toBe(visible ? 1 : 0);
    expect(Boolean(await getDiscoveryPublicListingBySlug(pool, slug))).toBe(visible);
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);
    if (slug === "active") {
      await handlers["identity.account.suspended"]!(
        buildTransportEvent(
          "identity.account.suspended",
          {},
          {
            id: "evt_suspend",
            streamId: "identity.account-acc_active",
            streamVersion: 2,
            globalPosition: "2",
            timing: { occurredAt: "2026-10-17T00:00:02.000Z", recordedAt: "2026-10-17T00:00:02.000Z" },
          },
        ),
      );
      expect(await getDiscoveryPublicListingBySlug(pool, "active")).toBeNull();
    }
  });
});
