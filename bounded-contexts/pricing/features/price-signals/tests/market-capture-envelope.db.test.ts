import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { createTcgplayerMarketCapture } from "../api/market-capture";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("provider market-capture envelope reconciliation", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_capture_envelope");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
    await pool.query(
      `INSERT INTO pricing_external_catalog_item_reference_inputs
         (provider_key, external_key, catalog_item_id, updated_at)
       VALUES ('tcgplayer','product:7001','cat_synthetic','2026-09-01T14:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO pricing_external_product_reference_inputs
         (provider_key, external_key, catalog_item_id, catalog_product_key, selected_options, updated_at)
       VALUES ('tcgplayer','sku:9001','cat_synthetic','cat_synthetic::','[]','2026-09-01T14:00:00.000Z')`,
    );
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("persists complete only for exact terminal reconciliation, including observed-empty", async () => {
    await runCapture(pool, [salesPage({ total: 1, rows: [sale(1)] })]);
    await expect(salesHeader(pool)).resolves.toMatchObject({ sales_coverage: "complete", sales_returned_count: 1 });

    await resetCaptureFacts(pool);
    await runCapture(pool, [salesPage({ total: 0, rows: [] })]);
    await expect(salesHeader(pool)).resolves.toMatchObject({ sales_status: "observed", sales_coverage: "complete" });
  });

  it.each([
    ["result/page mismatch", [salesPage({ total: 1, rows: [sale(1)], resultCount: 2 })], {}],
    [
      "total drift",
      [
        salesPage({ total: 2, rows: [sale(1)], nextPage: "Yes" }),
        salesPage({ total: 3, rows: [sale(2)], previousPage: "Yes" }),
      ],
      { pageSize: 1, limit: 3 },
    ],
    ["cap+1 response", [salesPage({ total: 2, rows: [sale(1), sale(2)], resultCount: 2 })], { pageSize: 1, limit: 1 }],
    [
      "cumulative cap+1 through a rejected row",
      [
        salesPage({ total: 3, rows: [sale(1), { ...sale(2), orderDate: "invalid" }], nextPage: "Yes" }),
        salesPage({ total: 3, rows: [sale(3)], previousPage: "Yes" }),
      ],
      { pageSize: 2, limit: 2 },
    ],
    ["unsafe empty continuation", [salesPage({ total: 1, rows: [], nextPage: "Yes" })], { pageSize: 1 }],
    [
      "repeated continuation",
      [
        salesPage({ total: 3, rows: [sale(1)], nextPage: "Yes" }),
        salesPage({ total: 3, rows: [sale(2)], previousPage: "Yes", nextPage: "Yes" }),
        salesPage({ total: 3, rows: [sale(2)], previousPage: "Yes", nextPage: "Yes" }),
      ],
      { pageSize: 1, pageBudget: 3, limit: 3 },
    ],
  ] as const)("classifies %s as inconsistent", async (_label, pages, salesPolicy) => {
    await runCapture(pool, pages, salesPolicy);
    await expect(salesHeader(pool)).resolves.toMatchObject({ sales_coverage: "inconsistent" });
  });

  it("preserves request-cap, page-budget, and unavailable classifications", async () => {
    await runCapture(pool, [salesPage({ total: 2, rows: [sale(1)], nextPage: "Yes" })], { pageSize: 1, limit: 1 });
    await expect(salesHeader(pool)).resolves.toMatchObject({ sales_coverage: "request-cap-truncated" });

    await resetCaptureFacts(pool);
    await runCapture(pool, [salesPage({ total: 2, rows: [sale(1)], nextPage: "Yes" })], {
      pageSize: 1,
      pageBudget: 1,
      limit: 2,
    });
    await expect(salesHeader(pool)).resolves.toMatchObject({ sales_coverage: "page-budget-truncated" });

    await resetCaptureFacts(pool);
    await runCapture(pool, []);
    await expect(salesHeader(pool)).resolves.toMatchObject({ sales_status: "unavailable", sales_coverage: "unknown" });
  });
});

async function runCapture(
  pool: PgTransactionalPool,
  pages: readonly unknown[],
  salesPolicy: Readonly<{ pageSize?: number; pageBudget?: number; limit?: number }> = {},
) {
  let page = 0;
  const run = createTcgplayerMarketCapture({
    pool,
    transport: transport(() => {
      const value = pages[page++];
      if (value === undefined) throw Object.assign(new Error("synthetic-unavailable-secret"), { status: 503 });
      return value;
    }),
    receiptSink: { kind: "not-mounted" },
    now: clock(),
    resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
    resolveObservationPolicy: async () => ({
      revisionId: "synthetic-observation-r1",
      value: {
        ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
        capturesPerPass: 1,
        sales: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales, ...salesPolicy },
      },
    }),
    resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
    recordTcgplayerPriceSignal: async () => ({
      status: "unresolved",
      reason: "sku-reference-not-mapped",
      externalKey: "sku:9001",
    }),
  });
  await expect(run()).resolves.toMatchObject({ status: "completed", capturesCommitted: 1 });
}

function transport(nextSalesPage: () => unknown): TcgplayerMarketTransport {
  return {
    mpGateway: {
      post: async <T>() =>
        [
          {
            skuId: 9001,
            marketPrice: 10,
            lowestPrice: 9,
            highestPrice: 11,
            priceCount: 3,
            calculatedAt: "2026-09-01T15:00:00.000Z",
          },
        ] as T,
    },
    mpApi: { post: async <T>() => nextSalesPage() as T },
    mpSearchApi: {
      post: async <T>() => {
        throw new Error("synthetic-listings-unavailable") as T;
      },
    },
    infiniteApi: {
      get: async <T>() => {
        throw new Error("synthetic-history-unavailable") as T;
      },
    },
  };
}

function salesPage(
  input: Readonly<{
    total: number;
    rows: readonly ReturnType<typeof sale>[];
    resultCount?: number;
    previousPage?: "Yes" | "";
    nextPage?: "Yes" | "";
  }>,
) {
  return {
    previousPage: input.previousPage ?? "",
    nextPage: input.nextPage ?? "",
    resultCount: input.resultCount ?? input.rows.length,
    totalResults: input.total,
    data: input.rows,
  };
}

function sale(index: number) {
  return {
    condition: "Near Mint",
    variant: "Normal",
    language: "English",
    quantity: 1,
    title: "synthetic",
    listingType: "All",
    customListingId: `synthetic-${index}`,
    purchasePrice: 5 + index,
    shippingPrice: 0,
    orderDate: `2026-09-0${index}T00:00:00.000Z`,
  };
}

async function salesHeader(pool: PgTransactionalPool) {
  const result = await pool.query<{
    sales_status: string;
    sales_coverage: string;
    sales_returned_count: number;
  }>(
    `SELECT sales_status, sales_coverage, sales_returned_count
     FROM pricing_external_market_captures`,
  );
  return result.rows[0];
}

async function resetCaptureFacts(pool: PgTransactionalPool) {
  await pool.query("TRUNCATE pricing_external_market_capture_cursors, pricing_external_market_captures CASCADE");
}

function clock() {
  let value = Date.parse("2026-09-01T14:59:59.000Z");
  return () => new Date((value += 1_000)).toISOString();
}
