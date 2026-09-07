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
import type { ProviderObservationCapture } from "../domain/provider-observation-mapper";
import {
  commitProviderObservationCapture,
  type MarketCaptureWorkItem,
} from "../read-model/provider-observation-writes";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("provider observation source-watermark interleaving", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_provider_watermarks");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("ends t1/A -> t3/A -> t2/B at t3/A and advances equal-value metadata", async () => {
    await commitProviderObservationCapture(
      pool,
      "tcgplayer",
      work("", 0, "product:7001", 1),
      capture("c1", "2026-09-01T00:00:00.000Z", "A", "5.00"),
    );
    await commitProviderObservationCapture(
      pool,
      "tcgplayer",
      work("product:7001", 1, "product:7001", 2),
      capture("c3", "2026-09-03T00:00:00.000Z", "A", "5.00"),
    );
    await commitProviderObservationCapture(
      pool,
      "tcgplayer",
      work("product:7001", 2, "", 3),
      capture("c2", "2026-09-02T00:00:00.000Z", "B", "9.00"),
    );
    const weekly = await pool.query<{ provider_condition: string; low_sale_amount: string; last_capture_id: string }>(
      `SELECT provider_condition, low_sale_amount::text, last_capture_id FROM pricing_external_weekly_sale_buckets`,
    );
    const snapshot = await pool.query<{ cheapest_delivered_amount: string; last_capture_id: string }>(
      `SELECT cheapest_delivered_amount::text, last_capture_id FROM pricing_external_listing_snapshots`,
    );
    expect(weekly.rows).toEqual([{ provider_condition: "A", low_sale_amount: "5.00", last_capture_id: "c3" }]);
    expect(snapshot.rows).toEqual([{ cheapest_delivered_amount: "5.00", last_capture_id: "c3" }]);
  });
});

function work(
  afterExternalKey: string,
  generation: number,
  nextAfter: string,
  nextGeneration: number,
): MarketCaptureWorkItem {
  return {
    productExternalKey: "product:7001",
    productId: 7001,
    catalogItemId: "cat_synthetic",
    skus: [],
    expectedCursor: { afterExternalKey, generation },
    nextCursor: { afterExternalKey: nextAfter, generation: nextGeneration },
  };
}

function capture(captureId: string, observedAt: string, condition: string, amount: string): ProviderObservationCapture {
  return {
    header: {
      captureId,
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      externalKey: "product:7001",
      signalPassStartedAt: observedAt,
      signalPolicyRevisionId: "synthetic-signal-r1",
      productsPerPass: 1,
      captureStartedAt: observedAt,
      captureCompletedAt: observedAt,
      observationPolicyRevisionId: "synthetic-observation-r1",
      statHygienePolicyRevisionId: "synthetic-stat-r1",
      capturesPerPass: 1,
      currency: "usd",
      authenticatedRequest: false,
      recordedSignalCount: 1,
      unresolvedSignalCount: 0,
      outcomeKind: "recorded",
      reasonCode: null,
      rejectedRowCount: 0,
      requestPosture: null,
      sales: null,
      listings: null,
      history: null,
    },
    sales: [],
    weekly: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:9001",
        catalogItemId: "cat_synthetic",
        catalogProductKey: "cat_synthetic::",
        weekStart: "2026-08-25",
        providerCondition: condition,
        providerVariant: "Normal",
        providerLanguage: "English",
        transactionCount: 1,
        quantitySold: 1,
        lowSaleAmount: amount,
        highSaleAmount: amount,
        lowDeliveredAmount: amount,
        highDeliveredAmount: amount,
        providerMarketAmount: amount,
        captureId,
        observedAt,
      },
    ],
    snapshots: [
      {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        providerVariant: "Normal",
        providerLanguage: "English",
        providerCondition: "Near Mint",
        observedOn: "2026-09-01",
        distinctSellerCount: 1,
        cheapestDeliveredAmount: amount,
        secondCheapestDeliveredAmount: null,
        captureId,
        observedAt,
      },
    ],
    askDepth: [],
  };
}
