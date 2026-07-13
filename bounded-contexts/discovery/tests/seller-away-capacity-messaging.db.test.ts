import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildDiscoveryMarketProjectionHandlers } from "../support/market-support/projection";
import { buyerVisibleListingPredicateSql } from "../support/market-support/listing-visibility";
import { getDiscoveryPublicListingBySlug } from "../support/market-support/queries";
import { discoverySchemaSql } from "../support/runtime-support/schema";

/**
 * Buyer-facing away & at-capacity messaging (m127 #4883): covers the
 * discovery-side projection handlers (resume instant, at-capacity signal),
 * the predicate-unchanged guarantee for search/browse, and the direct
 * listing page's relaxed "visible but unbuyable" query.
 */

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["discovery"] as const;

describeDb("discovery buyer-facing away & at-capacity messaging", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "discovery_away_capacity_messaging",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.discovery;
  });

  beforeEach(async () => {
    nextGlobalPosition = 0;
    await resetMultiContextTestSchemas({ discovery: pool });
    await pool.query(discoverySchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("captures the resume instant on disable and clears it on enable", async () => {
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);

    await handlers["marketplace.seller-listing-availability.disabled"]!(
      event("marketplace.seller-listing-availability.disabled", "marketplace.seller-listing-availability-acc_seller", {
        accountId: "acc_seller",
        reasonCategory: "travel",
        availableAgainOn: "2026-07-20",
        availableAgainAt: "2026-07-20T05:00:00.000Z",
      }),
    );

    const account = await selectAccount(pool, "acc_seller");
    expect(account).toMatchObject({
      seller_listing_availability_status: "unavailable",
      seller_available_again_at: "2026-07-20 05:00:00+00",
    });

    await handlers["marketplace.seller-listing-availability.enabled"]!(
      event("marketplace.seller-listing-availability.enabled", "marketplace.seller-listing-availability-acc_seller", {
        accountId: "acc_seller",
      }),
    );

    const reenabled = await selectAccount(pool, "acc_seller");
    expect(reenabled).toMatchObject({
      seller_listing_availability_status: "available",
      seller_available_again_at: null,
    });
  });

  it("leaves the resume instant null for a legacy disabled event carrying no availableAgainAt key", async () => {
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);

    await handlers["marketplace.seller-listing-availability.disabled"]!(
      event("marketplace.seller-listing-availability.disabled", "marketplace.seller-listing-availability-acc_legacy", {
        accountId: "acc_legacy",
        reasonCategory: "other",
        availableAgainOn: "2026-08-01",
        // No `availableAgainAt` key at all -- matches a pre-#4878 stored event.
      }),
    );

    const account = await selectAccount(pool, "acc_legacy");
    expect(account).toMatchObject({
      seller_listing_availability_status: "unavailable",
      seller_available_again_at: null,
    });
  });

  it("flags and clears the at-capacity signal", async () => {
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);

    await handlers["ordering.seller-capacity.reached"]!(
      event("ordering.seller-capacity.reached", "ordering.seller-capacity-acc_seller", { accountId: "acc_seller" }),
    );
    expect(await selectAccount(pool, "acc_seller")).toMatchObject({ seller_at_capacity: true });

    await handlers["ordering.seller-capacity.cleared"]!(
      event("ordering.seller-capacity.cleared", "ordering.seller-capacity-acc_seller", { accountId: "acc_seller" }),
    );
    expect(await selectAccount(pool, "acc_seller")).toMatchObject({ seller_at_capacity: false });
  });

  it("is idempotent and out-of-order-safe: a late-arriving stale event can never clobber a newer crossing", async () => {
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);

    // Reached at t=2, then cleared at t=3 (the "newer" state on the wire).
    await handlers["ordering.seller-capacity.reached"]!(
      eventAt(
        "ordering.seller-capacity.reached",
        "ordering.seller-capacity-acc_seller",
        { accountId: "acc_seller" },
        2,
      ),
    );
    await handlers["ordering.seller-capacity.cleared"]!(
      eventAt(
        "ordering.seller-capacity.cleared",
        "ordering.seller-capacity-acc_seller",
        { accountId: "acc_seller" },
        3,
      ),
    );
    expect(await selectAccount(pool, "acc_seller")).toMatchObject({ seller_at_capacity: false });

    // A duplicate/out-of-order redelivery of the t=2 "reached" event arrives
    // after the t=3 "cleared" state is already projected -- it must be a
    // no-op, not a regression back to at_capacity: true.
    await handlers["ordering.seller-capacity.reached"]!(
      eventAt(
        "ordering.seller-capacity.reached",
        "ordering.seller-capacity-acc_seller",
        { accountId: "acc_seller" },
        2,
      ),
    );
    expect(await selectAccount(pool, "acc_seller")).toMatchObject({ seller_at_capacity: false });

    // Replaying the exact same t=3 "cleared" event again (duplicate delivery)
    // is idempotent.
    await handlers["ordering.seller-capacity.cleared"]!(
      eventAt(
        "ordering.seller-capacity.cleared",
        "ordering.seller-capacity-acc_seller",
        { accountId: "acc_seller" },
        3,
      ),
    );
    expect(await selectAccount(pool, "acc_seller")).toMatchObject({ seller_at_capacity: false });
  });

  it("keeps the buyer-visible search/browse predicate unchanged: away excluded, at-capacity still visible", async () => {
    await pool.query(
      `INSERT INTO discovery_market_accounts (account_id, seller_listing_availability_status, seller_at_capacity)
       VALUES ('acc_away', 'unavailable', false), ('acc_at_capacity', 'available', true)`,
    );
    await insertListing(pool, { listingId: "lst_away", accountId: "acc_away" });
    await insertListing(pool, { listingId: "lst_at_capacity", accountId: "acc_at_capacity" });

    const result = await pool.query<{ listing_id: string }>(
      `SELECT listing.listing_id
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE ${buyerVisibleListingPredicateSql("listing", "account")}
       ORDER BY listing.listing_id`,
    );

    // Away stays excluded from search/browse (unchanged choke point); at
    // capacity does NOT filter the predicate -- it stays visible there too,
    // "visible but unbuyable" being a purchase-action concern, not a
    // discoverability one.
    expect(result.rows.map((row) => row.listing_id)).toEqual(["lst_at_capacity"]);
  });

  it("returns away and at-capacity listings from the direct listing page query instead of null", async () => {
    await pool.query(
      `INSERT INTO discovery_market_accounts
         (account_id, seller_listing_availability_status, seller_available_again_at, seller_at_capacity)
       VALUES
         ('acc_away', 'unavailable', '2026-07-20T05:00:00.000Z', false),
         ('acc_away_indefinite', 'unavailable', NULL, false),
         ('acc_at_capacity', 'available', NULL, true)`,
    );
    await insertListing(pool, { listingId: "lst_away", accountId: "acc_away", slug: "lst-away" });
    await insertListing(pool, {
      listingId: "lst_away_indefinite",
      accountId: "acc_away_indefinite",
      slug: "lst-away-indefinite",
    });
    await insertListing(pool, { listingId: "lst_at_capacity", accountId: "acc_at_capacity", slug: "lst-at-capacity" });
    // A genuinely gone listing (zero quantity) stays excluded -- "visible but
    // unbuyable" only applies to structurally real listings.
    await insertListing(pool, {
      listingId: "lst_sold_out",
      accountId: "acc_at_capacity",
      slug: "lst-sold-out",
      quantityCap: 0,
    });

    const away = await getDiscoveryPublicListingBySlug(pool, "lst-away");
    expect(away).toMatchObject({
      seller_listing_availability_status: "unavailable",
      seller_available_again_at: "2026-07-20 05:00:00+00",
    });

    const awayIndefinite = await getDiscoveryPublicListingBySlug(pool, "lst-away-indefinite");
    expect(awayIndefinite).toMatchObject({
      seller_listing_availability_status: "unavailable",
      seller_available_again_at: null,
    });

    const atCapacity = await getDiscoveryPublicListingBySlug(pool, "lst-at-capacity");
    expect(atCapacity).toMatchObject({
      seller_listing_availability_status: "available",
      seller_at_capacity: true,
    });

    const soldOut = await getDiscoveryPublicListingBySlug(pool, "lst-sold-out");
    expect(soldOut).toBeNull();
  });
});

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for discovery away/capacity messaging tests.");
  }

  return databaseBaseUrl;
}

async function selectAccount(pool: PgTransactionalPool, accountId: string) {
  const result = await pool.query<{
    seller_listing_availability_status: string;
    seller_available_again_at: string | null;
    seller_at_capacity: boolean;
  }>(
    `SELECT
       seller_listing_availability_status,
       seller_available_again_at::text AS seller_available_again_at,
       seller_at_capacity
     FROM discovery_market_accounts
     WHERE account_id = $1`,
    [accountId],
  );

  return result.rows[0] ?? null;
}

async function insertListing(
  pool: PgTransactionalPool,
  params: Readonly<{ listingId: string; accountId: string; slug?: string; quantityCap?: number }>,
) {
  await pool.query(
    `INSERT INTO discovery_market_listings (
       listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id,
       product_id, item_title, item_subtitle, selected_options, product_summary, product_measure_snapshot,
       storage_location_name, ship_from_code, price_amount, shipping_allowance_percentage_bps, quantity_cap,
       supply_total_quantity, active_held_quantity, status, created_at, updated_at
     ) VALUES (
       $1, $2, 'prd_1', $3, 'inv_1', 'cat_1', 'prd_1', 'Charizard', NULL, '[]'::jsonb, 'Raw',
       '{"catalogItemId":"cat_1","productId":"prd_1","measureVersion":"pm_raw_v1"}'::jsonb,
       'STL Main', 'STL', '10.00', 500, $4, NULL, 0, 'active', now(), now()
     )`,
    [params.listingId, params.slug ?? params.listingId, params.accountId, params.quantityCap ?? 3],
  );
}

let nextGlobalPosition = 0;

function event(type: string, streamId: string, data: TransportEvent["data"]): TransportEvent {
  nextGlobalPosition += 1;
  return eventAt(type, streamId, data, nextGlobalPosition);
}

function eventAt(type: string, streamId: string, data: TransportEvent["data"], position: number): TransportEvent {
  const recordedAt = new Date(Date.UTC(2026, 5, 12, 12, position, 0)).toISOString();

  return buildTransportEvent(type, data, {
    id: `evt_${position}`,
    streamId,
    streamVersion: position,
    globalPosition: String(position),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_actor", forAccountId: "acc_actor" },
    timing: { occurredAt: recordedAt, recordedAt },
  });
}
