import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketTradesProjectionHandlers } from "../../market-trades/integrations/source/source-projection";
import {
  buildPricingCatalogInputProjectionHandlers,
  buildPricingMarketplaceInputProjectionHandlers,
} from "../../recommendations/integrations/source/source-projection";
import { runDailyRollupCloser } from "../../market-rollups/read-model/rollup-maintenance";
import {
  getPricingCatalogItemBySlugOrId,
  getPublicMarketPageData,
  listPublicMarketPageSlugs,
} from "../read-model/queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

// Monotonic version stamped in delivery order so the projection's stream-version
// guards advance across an entity's lifecycle events even when these seed events
// are not all keyed by the same streamId (mirrors real ordered delivery).
let nextEventStreamVersion = 0;
function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  nextEventStreamVersion += 1;
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
    streamVersion: nextEventStreamVersion,
    data,
    timing: { recordedAt },
  } as never;
}

describeDb("pricing public market pages read model", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "pricing_public_market_pages",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedCatalogItem(
    pool: PgTransactionalPool,
    overrides: { itemId?: string; status?: "draft" | "active" } = {},
  ) {
    const itemId = overrides.itemId ?? "cat_1";
    const handlers = buildPricingCatalogInputProjectionHandlers(pool);
    await handlers["catalog.catalog-item.created"]!(
      event(
        "catalog.catalog-item.created",
        { itemId, title: "Charizard (Base Set)", subtitle: "4/102 Holo" },
        "2026-06-01T00:00:00.000Z",
      ),
    );
    if (overrides.status !== "draft") {
      await handlers["catalog.catalog-item.published"]!(
        event("catalog.catalog-item.published", {}, "2026-06-01T00:01:00.000Z", `catalog.item-${itemId}`),
      );
    }
    return itemId;
  }

  async function seedTradesAndListing(pool: PgTransactionalPool, catalogItemId: string, productId: string) {
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    for (const [orderId, price, buyerAccountId] of [
      ["ord_1", "18.00", "buyer_1"],
      ["ord_2", "20.00", "buyer_2"],
      ["ord_3", "22.00", "buyer_3"],
    ] as const) {
      await tradeHandlers["ordering.order.created"]!(
        event(
          "ordering.order.created",
          {
            orderId,
            sourceType: "cart-checkout",
            buyerAccountId,
            sellerAccountId: "seller_1",
            lines: [{ lineId: "line_1", catalogItemId, productId, unitPriceAmount: price, quantity: 1 }],
          },
          "2026-07-01T09:00:00.000Z",
        ),
      );
      await tradeHandlers["ordering.order.ready-for-fulfillment-recorded"]!(
        event(
          "ordering.order.ready-for-fulfillment-recorded",
          { orderId, readyForFulfillmentAt: "2026-07-01T10:00:00.000Z" },
          "2026-07-01T10:00:00.000Z",
          orderId,
        ),
      );
    }

    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    await listingHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing_1",
          accountId: "seller_1",
          catalogItemId,
          productId,
          priceAmount: "21.00",
          quantityCap: 1,
        },
        "2026-07-01T11:00:00.000Z",
      ),
    );
    await listingHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "2026-07-01T11:01:00.000Z", "marketplace.listing-listing_1"),
    );
  }

  it("resolves a published catalog item by its minted slug", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);

    const bySlug = await getPricingCatalogItemBySlugOrId(pool, "charizard-base-set-4-102-holo-cat-1-5e05dn");
    expect(bySlug?.catalogItemId).toBe("cat_1");
    expect(bySlug?.title).toBe("Charizard (Base Set)");

    const byId = await getPricingCatalogItemBySlugOrId(pool, "cat_1");
    expect(byId?.slug).toBe(bySlug?.slug);
  });

  it("does not resolve a draft (unpublished) catalog item -- the public page 404s", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool, { status: "draft" });

    const resolved = await getPricingCatalogItemBySlugOrId(pool, "cat_1");
    expect(resolved).toBeNull();
  });

  it("returns null for an unknown slug", async () => {
    const resolved = await getPricingCatalogItemBySlugOrId(pools.pricing, "no-such-item-zzz");
    expect(resolved).toBeNull();
  });

  it("composes the full public market page payload with rollup series and stats", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);
    await seedTradesAndListing(pool, "cat_1", "prod_near_mint");
    await runDailyRollupCloser(pool, { now: "2026-07-02T00:00:00.000Z" });

    const page = await getPublicMarketPageData(pool, "cat_1", { now: new Date("2026-07-02T00:00:00.000Z") });

    expect(page).not.toBeNull();
    expect(page?.productId).toBe("prod_near_mint");
    expect(page?.series.length).toBeGreaterThan(0);
    expect(page?.aggregate?.tradeCount30d).toBe(3);
    expect(page?.marketState?.activeListingCount).toBe(1);
  });

  it("never leaks account or transaction-party identifiers anywhere in the composed payload (privacy test)", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);
    await seedTradesAndListing(pool, "cat_1", "prod_near_mint");
    await runDailyRollupCloser(pool, { now: "2026-07-02T00:00:00.000Z" });

    const page = await getPublicMarketPageData(pool, "cat_1", { now: new Date("2026-07-02T00:00:00.000Z") });
    const serialized = JSON.stringify(page);

    for (const forbidden of ["buyer_1", "buyer_2", "buyer_3", "seller_1", "accountId", "account_id"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("resolves the most-traded product as primary when a catalog item has multiple products", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);
    // prod_low gets 1 trade; prod_high gets 3 -- prod_high should win as primary.
    await seedTradesAndListing(pool, "cat_1", "prod_high");
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await tradeHandlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: "ord_low",
          sourceType: "cart-checkout",
          buyerAccountId: "buyer_9",
          sellerAccountId: "seller_1",
          lines: [
            { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_low", unitPriceAmount: "5.00", quantity: 1 },
          ],
        },
        "2026-07-01T09:00:00.000Z",
      ),
    );
    await tradeHandlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: "ord_low", readyForFulfillmentAt: "2026-07-01T10:00:00.000Z" },
        "2026-07-01T10:00:00.000Z",
        "ord_low",
      ),
    );
    await runDailyRollupCloser(pool, { now: "2026-07-02T00:00:00.000Z" });

    const page = await getPublicMarketPageData(pool, "cat_1", { now: new Date("2026-07-02T00:00:00.000Z") });
    expect(page?.productId).toBe("prod_high");
  });

  it("still renders (with null productId, empty series/stats) for a published item with zero market activity", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);

    const page = await getPublicMarketPageData(pool, "cat_1");

    expect(page).not.toBeNull();
    expect(page?.productId).toBeNull();
    expect(page?.series).toEqual([]);
    expect(page?.aggregate).toBeNull();
  });

  it("lists sitemap-feeding slugs only for catalog items with recorded trade history", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool, { itemId: "cat_traded" });
    await seedCatalogItem(pool, { itemId: "cat_untraded" });
    await seedTradesAndListing(pool, "cat_traded", "prod_1");
    await runDailyRollupCloser(pool, { now: "2026-07-02T00:00:00.000Z" });

    const entries = await listPublicMarketPageSlugs(pool);
    const slugs = entries.map((entry) => entry.slug);

    expect(slugs.some((slug) => slug.startsWith("charizard-base-set-4-102-holo-cat-traded-"))).toBe(true);
    expect(slugs.some((slug) => slug.startsWith("charizard-base-set-4-102-holo-cat-untraded-"))).toBe(false);
  });
});
