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
import { searchDiscoveryItems } from "../features/search/read-model/queries";

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
      INSERT INTO discovery_search_items
        (catalog_item_id, slug, title, status, category_slugs, search_text, search_text_simple, dimension_filter_values)
      VALUES ('cat_one', 'item-one', 'Item', 'active', '["cards"]'::jsonb,
        to_tsvector('english', 'Item'), to_tsvector('simple', 'Item'),
        '[{"dimensionId":"finish","label":"Finish","optionId":"foil","optionLabel":"Foil"}]'::jsonb);
      INSERT INTO discovery_market_listings
        (listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         item_title, price_amount, price_currency_code, listing_stream_version, quantity_cap, supply_total_quantity,
         active_held_quantity, product_measure_snapshot, status)
      VALUES ('lst_one', 'listing-one', 'item-one', 'acc_seller', 'inv_one', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 4, 4, 0, '{}'::jsonb, 'active');
      INSERT INTO discovery_market_accounts (account_id, seller_slug, seller_display_name, status)
      VALUES ('acc_buyer', 'buyer-one', 'Buyer', 'active');
      INSERT INTO discovery_offer_demand_matches
        (offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title, price_amount, price_currency_code,
         offer_stream_version, quantity_requested, status, selected_options)
      VALUES ('off_one', 'acc_buyer', 'cat_one', 'cat_one::', 'Item', '8.00', 'USD', 1, 1, 'submitted',
        '[{"dimensionId":"finish","optionId":"foil"}]'::jsonb);
    `);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  async function status(
    eventType: "identity.account.suspended" | "identity.account.reactivated" | "identity.account.closed",
    version: number,
    globalPosition = String(version),
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
          globalPosition,
          timing: { occurredAt: `2026-10-17T00:00:0${version}.000Z`, recordedAt: `2026-10-17T00:00:0${version}.000Z` },
        },
      ),
    );
  }

  async function statusForAccount(
    accountId: string,
    eventType: "identity.account.suspended" | "identity.account.reactivated" | "identity.account.closed",
    version: number,
  ) {
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);
    await handlers[eventType]!(
      buildTransportEvent(
        eventType,
        {},
        {
          id: `evt_${accountId}_${version}`,
          streamId: `identity.account-${accountId}`,
          streamVersion: version,
          globalPosition: String(version),
          timing: { occurredAt: `2026-10-17T00:00:0${version}.000Z`, recordedAt: `2026-10-17T00:00:0${version}.000Z` },
        },
      ),
    );
  }

  async function offerReads() {
    const detail = await getDiscoveryItemDetail(pool, "item-one");
    const overlay = await getDiscoveryItemDetailSellerOverlay(pool, {
      accountId: "acc_seller",
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
    return {
      detail: detail?.offer_demand_matches.map((row) => row.offer_id) ?? [],
      overlay: overlay.accountOfferMatches.map((row) => row.offer_id),
      total: search.total,
      facetCount:
        search.facets.find((group) => group.id === "finish")?.values.find((value) => value.id === "foil")?.count ?? 0,
    };
  }

  async function listingReads() {
    const search = await searchDiscoveryItems(pool, { marketActivity: "listings", includeTotal: true });
    return {
      searchTotal: search.total,
      accountListings:
        (await getDiscoveryPublicAccountBySlug(pool, "seller-one"))?.listings.map((row) => row.listing_id) ?? [],
      summary: (await getDiscoveryItemDetail(pool, "item-one"))?.market_summary,
    };
  }

  async function outboxRows() {
    const result = await pool.query<{ source_global_position: string; patch_key: string; payload_json: string }>(
      `SELECT source_global_position::text, patch_key, payload_json
       FROM realtime_projection_outbox
       WHERE projection_name = 'discovery-market-projection'
       ORDER BY outbox_id ASC`,
    );
    return result.rows.map((row) => ({
      sourceGlobalPosition: row.source_global_position,
      patchKey: row.patch_key,
      changes: (JSON.parse(row.payload_json) as { changes: unknown[] }).changes,
    }));
  }

  it("hides direct listing and account content, emits removal, restores on reactivation, and fences stale events", async () => {
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toMatchObject({ listing_id: "lst_one" });
    expect((await getDiscoveryPublicAccountBySlug(pool, "seller-one"))!.listings).toHaveLength(1);
    expect((await getDiscoveryItemDetail(pool, "item-one"))!.market_summary).toMatchObject({ active_listing_count: 1 });
    expect(await listingReads()).toMatchObject({ searchTotal: 1, accountListings: ["lst_one"] });
    expect(
      (await getDiscoveryItemDetailSellerOverlay(pool, { accountId: "acc_seller", catalogItemId: "cat_one" }))
        .accountOfferMatches,
    ).toHaveLength(1);
    await status("identity.account.suspended", 2);
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toBeNull();
    expect((await getDiscoveryPublicAccountBySlug(pool, "seller-one"))!.listings).toHaveLength(0);
    expect((await getDiscoveryItemDetail(pool, "item-one"))!.market_summary).toBeNull();
    expect(await listingReads()).toMatchObject({ searchTotal: 0, accountListings: [] });
    expect(await outboxRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceGlobalPosition: "2",
          patchKey: "listing:lst_one",
          changes: [
            { op: "remove", entity: "discovery.marketListing", id: "lst_one" },
            { op: "remove", entity: "discovery.publicListingDetail", id: "lst_one" },
            expect.objectContaining({
              op: "summary",
              entity: "discovery.marketSummary",
              id: "cat_one",
              value: expect.objectContaining({
                active_listing_count: 0,
                lowest_price_amount: null,
                total_visible_quantity: 0,
              }),
            }),
          ],
        }),
      ]),
    );
    expect(
      (await getDiscoveryItemDetailSellerOverlay(pool, { accountId: "acc_seller", catalogItemId: "cat_one" }))
        .accountOfferMatches,
    ).toHaveLength(0);
    const suspendedOutboxCount = (
      await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM realtime_projection_outbox WHERE projection_name = 'discovery-market-projection'`,
      )
    ).rows[0].count;
    expect(Number(suspendedOutboxCount)).toBeGreaterThan(0);
    await status("identity.account.suspended", 2);
    await status("identity.account.reactivated", 1, "11");
    expect(
      (
        await pool.query<{ status: string; status_stream_version: number }>(
          `SELECT status, status_stream_version FROM discovery_market_accounts WHERE account_id = 'acc_seller'`,
        )
      ).rows[0],
    ).toEqual({ status: "suspended", status_stream_version: 2 });
    expect((await outboxRows()).some((row) => row.sourceGlobalPosition === "11")).toBe(false);
    await status("identity.account.reactivated", 3);
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toMatchObject({ listing_id: "lst_one" });
    expect(await listingReads()).toMatchObject({ searchTotal: 1, accountListings: ["lst_one"] });
    expect(await outboxRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceGlobalPosition: "3",
          patchKey: "listing:lst_one",
          changes: [
            expect.objectContaining({ op: "upsert", entity: "discovery.marketListing", id: "lst_one" }),
            expect.objectContaining({ op: "upsert", entity: "discovery.publicListingDetail", id: "lst_one" }),
            expect.objectContaining({
              op: "summary",
              value: expect.objectContaining({
                active_listing_count: 1,
                lowest_price_amount: "10.00",
                total_visible_quantity: 4,
              }),
            }),
          ],
        }),
      ]),
    );
    await status("identity.account.closed", 4);
    expect(await getDiscoveryPublicListingBySlug(pool, "listing-one")).toBeNull();
    await status("identity.account.closed", 3, "30");
    expect(
      (
        await pool.query<{ status: string; status_stream_version: number }>(
          `SELECT status, status_stream_version FROM discovery_market_accounts WHERE account_id = 'acc_seller'`,
        )
      ).rows[0],
    ).toEqual({ status: "closed", status_stream_version: 4 });
    expect((await outboxRows()).some((row) => row.sourceGlobalPosition === "30")).toBe(false);
  });

  it("hides and restores buyer Offers through every read and emits exact lifecycle patches", async () => {
    expect(await offerReads()).toEqual({ detail: ["off_one"], overlay: ["off_one"], total: 1, facetCount: 1 });
    await statusForAccount("acc_buyer", "identity.account.suspended", 2);
    expect(await offerReads()).toEqual({ detail: [], overlay: [], total: 0, facetCount: 0 });
    expect(await outboxRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceGlobalPosition: "2",
          patchKey: "offer:off_one",
          changes: [expect.objectContaining({ op: "remove", entity: "discovery.buyerOffer", id: "off_one" })],
        }),
      ]),
    );
    await statusForAccount("acc_buyer", "identity.account.reactivated", 3);
    expect(await offerReads()).toEqual({ detail: ["off_one"], overlay: ["off_one"], total: 1, facetCount: 1 });
    expect(await outboxRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceGlobalPosition: "3",
          patchKey: "offer:off_one",
          changes: [expect.objectContaining({ op: "upsert", entity: "discovery.buyerOffer", id: "off_one" })],
        }),
      ]),
    );
    await statusForAccount("acc_buyer", "identity.account.closed", 4);
    expect(await offerReads()).toEqual({ detail: [], overlay: [], total: 0, facetCount: 0 });
  });
});
