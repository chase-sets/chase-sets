import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
  getPrimaryTradedProductId,
  getPublicMarketPageData,
  listPublicMarketPageSlugs,
  type PublicMarketPageData,
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
      await tradeHandlers["payments.payment-captured"]!(
        event(
          "payments.payment-captured",
          { orderIds: [orderId], currencyCode: "USD", capturedAt: "2026-07-01T10:00:00.000Z" },
          "2026-07-01T10:00:00.000Z",
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

  async function seedSupply(
    listingId: string,
    price: string,
    overrides: {
      currency?: string | null;
      total?: number;
      cap?: number;
      status?: string;
      version?: number;
      inventoryReference?: boolean;
      inventoryRow?: boolean;
      catalogItemId?: string;
      productId?: string;
    } = {},
  ) {
    const inventoryId = `inventory_${listingId}`;
    const catalogItemId = overrides.catalogItemId ?? "cat_1";
    const productId = overrides.productId ?? "prod_1";
    if (overrides.inventoryRow !== false) {
      await pools.pricing.query(
        `INSERT INTO pricing_inventory_item_inputs
         (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity, updated_at, last_stream_version)
         VALUES ($1, 'seller_private', $2, $3, $4, now(), 1)`,
        [inventoryId, catalogItemId, productId, overrides.total ?? 10],
      );
    }
    await pools.pricing.query(
      `INSERT INTO pricing_market_listing_inputs
       (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id,
        price_amount, price_currency_code, quantity_cap, status, updated_at, last_stream_version)
       VALUES ($1, 'seller_private', $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
      [
        listingId,
        overrides.inventoryReference === false ? null : inventoryId,
        catalogItemId,
        productId,
        price,
        overrides.currency === undefined ? "USD" : overrides.currency,
        overrides.cap ?? 5,
        overrides.status ?? "active",
        overrides.version ?? 1,
      ],
    );
    return inventoryId;
  }

  async function seedHold(holdId: string, itemId: string, quantity: number, status = "active") {
    await pools.pricing.query(
      `INSERT INTO pricing_inventory_hold_inputs
       (hold_id, item_id, seller_account_id, quantity, status, updated_at, last_stream_version)
       VALUES ($1, $2, 'seller_private', $3, $4, now(), 1)`,
      [holdId, itemId, quantity, status],
    );
  }

  function asks(page: PublicMarketPageData | null) {
    expect(page).not.toBeNull();
    expect(page?.aggregates).toEqual([]);
    expect(page?.series).toEqual([]);
    return { liveAsks: page!.liveAsks, unpricedBuyableListingCount: page!.unpricedBuyableListingCount };
  }

  it("reads three buyable USD listings with zero trades: minimum 4.00 and listing count 3", async () => {
    await seedCatalogItem(pools.pricing);
    await seedSupply("first", "7.00");
    await seedSupply("second", "4.00");
    await seedSupply("third", "9.00");
    const query = vi.spyOn(pools.pricing, "query");
    let page: PublicMarketPageData | null;
    try {
      page = await getPublicMarketPageData(pools.pricing, "cat_1");
      expect(query.mock.calls.filter(([sql]) => sql.includes("AS buyable_listing_count"))).toHaveLength(1);
    } finally {
      query.mockRestore();
    }
    expect(asks(page)).toEqual({
      liveAsks: [{ currencyCode: "USD", minAskAmount: "4.00", buyableListingCount: 3 }],
      unpricedBuyableListingCount: 0,
    });
    for (const privateValue of ["seller_private", "inventory_", "listing_id", "hold_id"]) {
      expect(JSON.stringify(page)).not.toContain(privateValue);
    }
  });

  it("groups zero-trade asks by currency and keeps unpriced buyable listings separate", async () => {
    await seedCatalogItem(pools.pricing);
    await seedSupply("usd_1", "6.00");
    await seedSupply("usd_2", "4.00");
    await seedSupply("eur_1", "8.00", { currency: "EUR" });
    await seedSupply("eur_2", "5.00", { currency: "EUR" });
    await seedSupply("unpriced", "0.01", { currency: null });
    expect(asks(await getPublicMarketPageData(pools.pricing, "cat_1"))).toEqual({
      liveAsks: [
        { currencyCode: "EUR", minAskAmount: "5.00", buyableListingCount: 2 },
        { currencyCode: "USD", minAskAmount: "4.00", buyableListingCount: 2 },
      ],
      unpricedBuyableListingCount: 1,
    });
  });

  const exclusions = [
    { name: "exhausted inventory", supply: { total: 0 }, from: "inventory.total_quantity", to: "1" },
    { name: "zero quantity cap", supply: { cap: 0 }, from: "listing.quantity_cap", to: "1" },
    { name: "zero stream version", supply: { version: 0 }, from: "listing.last_stream_version > 0", to: "TRUE" },
    { name: "paused listing", supply: { status: "paused" }, from: "listing.status = 'active'", to: "TRUE" },
    { name: "withdrawn listing", supply: { status: "withdrawn" }, from: "listing.status = 'active'", to: "TRUE" },
    {
      name: "missing inventory reference",
      supply: { inventoryReference: false },
      from: "inventory.item_id = listing.inventory_item_id",
      to: "inventory.item_id = COALESCE(listing.inventory_item_id, 'inventory_cheaper')",
    },
    {
      name: "missing projected inventory row",
      supply: { inventoryRow: false },
      from: "INNER JOIN pricing_inventory_item_inputs",
      to: "LEFT JOIN pricing_inventory_item_inputs",
    },
    {
      name: "other product",
      supply: { productId: "prod_other" },
      from: "listing.product_id = $2",
      to: "$2::text IS NOT NULL",
    },
    {
      name: "other catalog item",
      supply: { catalogItemId: "cat_other" },
      from: "listing.catalog_catalog_item_id = $1",
      to: "$1::text IS NOT NULL",
    },
    {
      name: "fully active-held inventory",
      supply: {},
      from: "COALESCE(held.quantity, 0)",
      to: "0",
    },
  ];

  it.each(exclusions)("excludes $name: candidate green and named bypass control red", async (control) => {
    await seedCatalogItem(pools.pricing);
    // Two qualifying rows keep primary-product selection fixed even for the other-product control.
    await seedSupply("baseline", "6.00");
    await seedSupply("baseline_2", "8.00");
    const cheaperInventory = await seedSupply("cheaper", "2.00", control.supply);
    if (control.name === "fully active-held inventory") {
      await seedHold("hold_1", cheaperInventory, 4);
      await seedHold("hold_2", cheaperInventory, 6);
    }
    const expected = {
      liveAsks: [{ currencyCode: "USD", minAskAmount: "6.00", buyableListingCount: 2 }],
      unpricedBuyableListingCount: 0,
    };
    expect(asks(await getPublicMarketPageData(pools.pricing, "cat_1"))).toEqual(expected);

    // Mutate only the named exclusion in the live read, then execute that SQL on the same real Postgres fixture.
    // This is a negative control, not a mocked result or a production bypass.
    let bypassQueries = 0;
    const bypassDb: PgQueryable = {
      query: <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("AS buyable_listing_count")) {
          expect(sql).toContain(control.from);
          sql = sql.replace(control.from, control.to);
          if (control.name === "missing projected inventory row") {
            sql = sql.replace("inventory.total_quantity", "COALESCE(inventory.total_quantity, 1)");
          }
          bypassQueries += 1;
        }
        return pools.pricing.query<Row>(sql, values);
      },
    };
    const bypass = asks(await getPublicMarketPageData(bypassDb, "cat_1"));
    expect(bypassQueries).toBe(1);
    expect(bypass).toEqual({
      liveAsks: [{ currencyCode: "USD", minAskAmount: "2.00", buyableListingCount: 3 }],
      unpricedBuyableListingCount: 0,
    });
    expect(() => expect(bypass).toEqual(expected)).toThrow();
    console.info(`BYPASS_CONTROL_RED: ${control.name}; candidate=6.00/count 2; bypass=2.00/count 3`);
  });

  it("excludes released holds: candidate green and named bypass control red", async () => {
    await seedCatalogItem(pools.pricing);
    await seedSupply("baseline", "6.00");
    const inventoryId = await seedSupply("cheaper", "2.00", { total: 5 });
    await seedHold("released", inventoryId, 5, "released");
    const expected = {
      liveAsks: [{ currencyCode: "USD", minAskAmount: "2.00", buyableListingCount: 2 }],
      unpricedBuyableListingCount: 0,
    };
    expect(asks(await getPublicMarketPageData(pools.pricing, "cat_1"))).toEqual(expected);

    let bypassQueries = 0;
    const bypassDb: PgQueryable = {
      query: <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("AS buyable_listing_count")) {
          expect(sql).toContain("hold.status = 'active'");
          sql = sql.replace("hold.status = 'active'", "TRUE");
          bypassQueries += 1;
        }
        return pools.pricing.query<Row>(sql, values);
      },
    };
    const bypass = asks(await getPublicMarketPageData(bypassDb, "cat_1"));
    expect(bypassQueries).toBe(1);
    expect(bypass).toEqual({
      liveAsks: [{ currencyCode: "USD", minAskAmount: "6.00", buyableListingCount: 1 }],
      unpricedBuyableListingCount: 0,
    });
    expect(() => expect(bypass).toEqual(expected)).toThrow();
    console.info("BYPASS_CONTROL_RED: released holds; candidate=2.00/count 2; bypass=6.00/count 1");
  });

  it("counts listings rather than holds or units and releasing active holds restores the cheaper ask", async () => {
    await seedCatalogItem(pools.pricing);
    await seedSupply("baseline", "6.00");
    const inventoryId = await seedSupply("cheaper", "2.00", { total: 5 });
    await seedHold("hold_1", inventoryId, 2);
    await seedHold("hold_2", inventoryId, 3);
    const read = async () => asks(await getPublicMarketPageData(pools.pricing, "cat_1"));
    expect((await read()).liveAsks).toEqual([{ currencyCode: "USD", minAskAmount: "6.00", buyableListingCount: 1 }]);
    await pools.pricing.query("UPDATE pricing_inventory_hold_inputs SET status = 'released' WHERE hold_id = 'hold_1'");
    expect((await read()).liveAsks).toEqual([{ currencyCode: "USD", minAskAmount: "2.00", buyableListingCount: 2 }]);
    await pools.pricing.query("UPDATE pricing_inventory_hold_inputs SET status = 'released' WHERE hold_id = 'hold_2'");
    expect((await read()).liveAsks).toEqual([{ currencyCode: "USD", minAskAmount: "2.00", buyableListingCount: 2 }]);
    await seedHold("hold_3", inventoryId, 1);
    await seedHold("hold_4", inventoryId, 1);
    expect((await read()).liveAsks).toEqual([{ currencyCode: "USD", minAskAmount: "2.00", buyableListingCount: 2 }]);
  });

  it("returns no live asks for exhausted and held active listings while preserving the snapshot count", async () => {
    await seedCatalogItem(pools.pricing);
    await seedSupply("exhausted", "1.00", { total: 0 });
    const held = await seedSupply("held", "2.00");
    await seedHold("all_held", held, 12);
    await runDailyRollupCloser(pools.pricing, { now: "2026-07-02T00:00:00.000Z" });
    const page = await getPublicMarketPageData(pools.pricing, "cat_1");
    expect(asks(page)).toEqual({ liveAsks: [], unpricedBuyableListingCount: 0 });
    expect(page?.marketState?.activeListingCount).toBe(2);
  });

  it("returns only the unpriced count when all buyable listings have null currency", async () => {
    await seedCatalogItem(pools.pricing);
    await seedSupply("unpriced_1", "1.00", { currency: null });
    await seedSupply("unpriced_2", "2.00", { currency: null });
    await seedSupply("unpriced_exhausted", "0.01", { currency: null, total: 0 });
    expect(asks(await getPublicMarketPageData(pools.pricing, "cat_1"))).toEqual({
      liveAsks: [],
      unpricedBuyableListingCount: 2,
    });
  });

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
    expect(page?.aggregates[0]?.tradeCount30d).toBe(3);
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
    await tradeHandlers["payments.payment-captured"]!(
      event(
        "payments.payment-captured",
        { orderIds: ["ord_low"], currencyCode: "USD", capturedAt: "2026-07-01T10:00:00.000Z" },
        "2026-07-01T10:00:00.000Z",
      ),
    );
    await runDailyRollupCloser(pool, { now: "2026-07-02T00:00:00.000Z" });

    const page = await getPublicMarketPageData(pool, "cat_1", { now: new Date("2026-07-02T00:00:00.000Z") });
    expect(page?.productId).toBe("prod_high");
  });

  it("ranks products by the sum of their currency rows and loads each currency series", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);
    await pool.query(`INSERT INTO pricing_product_market_aggregates
      (catalog_catalog_item_id, product_id, currency_code, trade_count_90d, updated_at)
      VALUES ('cat_1', 'A', 'USD', 10, now()),
             ('cat_1', 'B', 'USD', 6, now()), ('cat_1', 'B', 'EUR', 7, now())`);
    await pool.query(`INSERT INTO pricing_daily_product_rollups
      (catalog_catalog_item_id, product_id, day, currency_code, trade_count, median_price_amount, updated_at)
      VALUES ('cat_1', 'B', '2026-07-01', 'USD', 6, 10, now()),
             ('cat_1', 'B', '2026-07-01', 'EUR', 7, 20, now())`);
    expect(await getPrimaryTradedProductId(pool, "cat_1")).toBe("B");
    const query = vi.spyOn(pool, "query");
    const page = await getPublicMarketPageData(pool, "cat_1", { now: new Date("2026-07-02T00:00:00.000Z") });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    query.mockRestore();
    expect(statements.filter((sql) => sql.includes("FROM pricing_product_market_aggregates"))).toHaveLength(2);
    expect(statements.filter((sql) => sql.includes("FROM pricing_daily_product_rollups"))).toHaveLength(2);
    expect(page?.aggregates.map((aggregate) => aggregate.currencyCode)).toEqual(["EUR", "USD"]);
    expect(page?.series.map((point) => [point.currencyCode, point.medianPriceAmount])).toEqual([
      ["EUR", "20.00"],
      ["USD", "10.00"],
    ]);
  });

  it("does not request a rollup series for an active listing without aggregate currencies", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);
    await pool.query(`INSERT INTO pricing_market_listing_inputs
      (listing_id, seller_account_id, catalog_catalog_item_id, product_id, price_amount, quantity_cap, status, updated_at)
      VALUES ('listing_only', 'seller', 'cat_1', 'prod_empty', 10, 1, 'active', now())`);
    const query = vi.spyOn(pool, "query");
    const page = await getPublicMarketPageData(pool, "cat_1");
    const statements = query.mock.calls.map(([sql]) => String(sql));
    query.mockRestore();
    expect(page?.productId).toBe("prod_empty");
    expect(page?.aggregates).toEqual([]);
    expect(statements.filter((sql) => sql.includes("FROM pricing_daily_product_rollups"))).toHaveLength(0);
  });

  it("still renders (with null productId, empty series/stats) for a published item with zero market activity", async () => {
    const pool = pools.pricing;
    await seedCatalogItem(pool);

    const page = await getPublicMarketPageData(pool, "cat_1");

    expect(page).not.toBeNull();
    expect(page?.productId).toBeNull();
    expect(page?.series).toEqual([]);
    expect(page?.aggregates).toEqual([]);
    expect(page?.liveAsks).toEqual([]);
    expect(page?.unpricedBuyableListingCount).toBe(0);
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
