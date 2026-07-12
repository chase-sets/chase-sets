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
import { createBulkRepriceIngestionRuntime, type BulkRepriceMarketplaceListingGateway } from "../api/runtime";

/**
 * Manual throughput benchmark for the #4328 AC: "250k-row bulk file
 * processed within the published budget." Gated behind
 * RUN_BULK_REPRICE_BENCHMARK so it never runs in ordinary CI -- a 250k-row
 * run intentionally takes minutes, and this repeats work #4326/#4327 (the
 * chunked-append/terms-session throughput lane) already measure on their
 * own. This benchmark isolates what THIS feature adds on top: resolution,
 * diff-first suppression, and row-outcome bookkeeping, using a
 * near-zero-latency fake Marketplace gateway so the number reported is this
 * feature's own overhead, not Marketplace's append-lock contention (which
 * is #4163's instrumented concern and requires a real deployed environment
 * with concurrent traffic to measure honestly -- see the PR body for this
 * scoping note).
 *
 * Run: RUN_BULK_REPRICE_BENCHMARK=1 TEST_DATABASE_URL=... \
 *   pnpm --filter @chase-sets/pricing exec vitest run \
 *   features/bulk-reprice-ingestion/tests/bulk-reprice-ingestion-throughput-benchmark.db.test.ts
 */
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const runBenchmark = process.env.RUN_BULK_REPRICE_BENCHMARK === "1";
const describeBenchmark = databaseBaseUrl && runBenchmark ? describe : describe.skip;
const contextNames = ["pricing"] as const;
const TOTAL_ROWS = Number(process.env.BULK_REPRICE_BENCHMARK_ROWS ?? 250_000);
const UNCHANGED_RATIO = 0.9; // "typical delta ratios" per the issue -- most re-uploads are mostly unchanged.

describeBenchmark("pricing bulk reprice ingestion throughput benchmark (#4328)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "pricing_bulk_reprice_bench",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  }, 120_000);

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  }, 120_000);

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it(
    `processes ${TOTAL_ROWS} rows end-to-end with unchanged-row suppression measured`,
    async () => {
      const pool = pools.pricing;
      const accountId = "acc_bench_seller";

      // Bulk-seed pricing's own local listing read model directly -- this table has
      // no event-stream integrity constraint of its own (it is a plain projection
      // Marketplace's events feed), so a single generate_series INSERT is a faithful
      // stand-in for "250k listings already projected" without paying 250k
      // individual event appends just to set up the benchmark.
      const seedStart = Date.now();
      await pool.query(
        `INSERT INTO pricing_market_listing_inputs
           (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, price_amount, quantity_cap, status, updated_at)
         SELECT
           'lst_bench_' || generate_series,
           $1,
           NULL,
           'cat_bench',
           'cat_bench::',
           (10 + (generate_series % 500))::numeric(12,2),
           1,
           'active',
           now()
         FROM generate_series(1, $2)`,
        [accountId, TOTAL_ROWS],
      );
      const seedMs = Date.now() - seedStart;

      const rows = Array.from({ length: TOTAL_ROWS }, (_, index) => {
        const listingId = `lst_bench_${index + 1}`;
        // Mirrors the SQL seed exactly: listing lst_bench_N was seeded at 10 + (N % 500), N = index + 1.
        const currentPrice = 10 + ((index + 1) % 500);
        const unchanged = index % 10 !== 0; // 90% unchanged, 10% delta
        const newPriceAmount = unchanged ? currentPrice.toFixed(2) : (currentPrice + 1).toFixed(2);
        return { listingId, newPriceAmount };
      });

      const runtime = createBulkRepriceIngestionRuntime({ db: pool });
      const enqueueStart = Date.now();
      const job = await runtime.enqueueJob(
        { accountId, rows },
        {
          tenantId: "ten_1" as never,
          audit: { performedByUserId: "usr_1" as never, forAccountId: accountId as never },
        },
      );
      const enqueueMs = Date.now() - enqueueStart;

      let applyCallCount = 0;
      let totalUpdatesSent = 0;
      const marketplaceGateway: BulkRepriceMarketplaceListingGateway = {
        applyBulkListingPriceUpdates: async (body) => {
          applyCallCount += 1;
          totalUpdatesSent += body.updates.length;
          return {
            items: body.updates.map((update) => ({ listingId: update.listingId, outcome: "applied" as const })),
          };
        },
      };

      const processStart = Date.now();
      const processed = await runtime.processNextBulkRepriceJob({
        claimOwnerId: "bench_worker",
        claimTtlMs: 300_000,
        marketplaceListingGatewayForAccount: () => marketplaceGateway,
        inventorySkuGatewayForAccount: () => ({ resolveSellerSkusToInventoryItems: async () => [] }),
      });
      const processMs = Date.now() - processStart;

      const completedJob = await runtime.getJob(job.jobId);

      const expectedApplied = Math.ceil(TOTAL_ROWS / 10);
      const expectedUnchanged = TOTAL_ROWS - expectedApplied;

      console.log(
        JSON.stringify(
          {
            totalRows: TOTAL_ROWS,
            seedMs,
            enqueueMs,
            processMs,
            rowsPerSecond: Math.round((TOTAL_ROWS / processMs) * 1000),
            applyCallCount,
            totalUpdatesSent,
            result: completedJob?.result,
          },
          null,
          2,
        ),
      );

      expect(processed).toBe(1);
      expect(completedJob?.status).toBe("completed");
      expect(completedJob?.result?.applied).toBe(expectedApplied);
      expect(completedJob?.result?.unchanged).toBe(expectedUnchanged);
      expect(completedJob?.result?.failed).toBe(0);
      // The marketplace gateway is only ever called with the DELTA rows, never the unchanged ones.
      expect(totalUpdatesSent).toBe(expectedApplied);
    },
    30 * 60 * 1000,
  );
});
