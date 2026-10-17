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
import { module as discoveryModule } from "../index";
import { buildDiscoveryMarketProjectionHandlers } from "../support/market-support/projection";
import { getDiscoveryPublicAccountBySlug, getDiscoveryPublicListingBySlug } from "../support/market-support/queries";
import {
  getDiscoveryItemDetail,
  getDiscoveryItemDetailSellerOverlay,
} from "../features/item-detail/read-model/queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Discovery account DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Discovery account status visibility on Postgres", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["discovery"], "discovery_account_status");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).discovery;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ discovery: pool });
    await pool.query(realtimeOutboxSchemaSql);
    await bootstrapContextDatabase(discoveryModule, pool);
    await pool.query(`
      INSERT INTO discovery_market_accounts (account_id, seller_slug, seller_display_name, status, status_stream_version)
      VALUES ('acc_seller', 'seller-one', 'Seller', 'active', 1);
      INSERT INTO discovery_item_detail_pages (catalog_item_id, slug, title, status, product_schema)
      VALUES ('cat_one', 'item-one', 'Item', 'published', '{}'::jsonb);
      INSERT INTO discovery_market_listings
        (listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         item_title, price_amount, price_currency_code, listing_stream_version, quantity_cap, supply_total_quantity,
         active_held_quantity, product_measure_snapshot, status)
      VALUES ('lst_one', 'listing-one', 'item-one', 'acc_seller', 'inv_one', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 4, 4, 0, '{}'::jsonb, 'active');
      INSERT INTO discovery_market_accounts (account_id, seller_slug, seller_display_name, status)
      VALUES ('acc_buyer', 'buyer-one', 'Buyer', 'active');
      INSERT INTO discovery_offer_demand_matches
        (offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title, price_amount, price_currency_code,
         offer_stream_version, quantity_requested, status)
      VALUES ('off_one', 'acc_buyer', 'cat_one', 'cat_one::', 'Item', '8.00', 'USD', 1, 1, 'submitted');
    `);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  async function status(
    eventType: "identity.account.suspended" | "identity.account.reactivated" | "identity.account.closed",
    version: number,
  ) {
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);
    await handlers[eventType]!(
      buildTransportEvent(
        eventType,
        {},
        {
          id: `evt_${version}`,
          streamId: "identity.account-acc_seller",
          streamVersion: version,
          globalPosition: String(version),
          timing: { occurredAt: `2026-10-17T00:00:0${version}.000Z`, recordedAt: `2026-10-17T00:00:0${version}.000Z` },
        },
      ),
    );
  }

  it("hides direct listing and account content, emits removal, restores on reactivation, and fences stale events", async () => {
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toMatchObject({ listing_id: "lst_one" });
    expect((await getDiscoveryPublicAccountBySlug(pool, "seller-one"))!.listings).toHaveLength(1);
    expect((await getDiscoveryItemDetail(pool, "item-one"))!.market_summary).toMatchObject({ active_listing_count: 1 });
    expect(
      (await getDiscoveryItemDetailSellerOverlay(pool, { accountId: "acc_seller", catalogItemId: "cat_one" }))
        .accountOfferMatches,
    ).toHaveLength(1);
    await status("identity.account.suspended", 2);
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toBeNull();
    expect((await getDiscoveryPublicAccountBySlug(pool, "seller-one"))!.listings).toHaveLength(0);
    expect((await getDiscoveryItemDetail(pool, "item-one"))!.market_summary).toMatchObject({
      active_listing_count: 0,
      total_visible_quantity: 0,
    });
    expect(
      (await getDiscoveryItemDetailSellerOverlay(pool, { accountId: "acc_seller", catalogItemId: "cat_one" }))
        .accountOfferMatches,
    ).toHaveLength(0);
    expect(
      (
        await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM realtime_projection_outbox WHERE projection_name = 'discovery-market-projection'`,
        )
      ).rows[0].count,
    ).toBe("1");
    await status("identity.account.suspended", 2);
    await status("identity.account.reactivated", 1);
    expect(
      (
        await pool.query<{ status: string; status_stream_version: number }>(
          `SELECT status, status_stream_version FROM discovery_market_accounts WHERE account_id = 'acc_seller'`,
        )
      ).rows[0],
    ).toEqual({ status: "suspended", status_stream_version: 2 });
    await status("identity.account.reactivated", 3);
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toMatchObject({ listing_id: "lst_one" });
    await status("identity.account.closed", 4);
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toBeNull();
  });
});
