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
import {
  countProviderCompetingSellersAt,
  latestProviderMarketCapture,
  listProviderListingAskDepth,
  listProviderListingAskGroups,
  listProviderListingSnapshots,
  listProviderSaleEvidence,
  listProviderWeeklySaleBuckets,
} from "../read-model/provider-observation-queries";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("typed provider observation persistence and frozen queries", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_provider_observations");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
    await pool.query(
      `INSERT INTO pricing_external_catalog_item_reference_inputs (provider_key, external_key, catalog_item_id, updated_at) VALUES ('tcgplayer','product:7001','cat_synthetic','2026-09-01T14:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO pricing_external_product_reference_inputs (provider_key, external_key, catalog_item_id, catalog_product_key, selected_options, updated_at) VALUES ('tcgplayer','sku:9001','cat_synthetic','cat_synthetic::','[]','2026-09-01T14:00:00.000Z')`,
    );
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("round-trips capture-scoped multiplicity, weekly facts, depth, and provenance", async () => {
    const run = createTcgplayerMarketCapture({
      pool,
      transport: providerFixtureTransport(),
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
      resolveObservationPolicy: async () => ({
        revisionId: "synthetic-observation-r1",
        value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 1 },
      }),
      resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
      recordTcgplayerPriceSignal: async () => ({
        status: "unresolved",
        reason: "sku-reference-not-mapped",
        externalKey: "sku:9001",
      }),
    });
    await expect(run()).resolves.toMatchObject({ status: "completed", capturesCommitted: 1 });
    const sales = await listProviderSaleEvidence(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      soldSince: "2026-08-01T00:00:00.000Z",
    });
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      maxObservedTupleMultiplicity: 2,
      countSemantics: "provider-returned-max-per-capture",
      coverage: "complete-capture",
    });
    expect(sales[0]).toMatchObject({ currency: "usd", policyRevisionId: "synthetic-observation-r1" });
    await expect(
      listProviderSaleEvidence(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        soldSince: "2026-08-01T00:00:00.000Z",
        soldUntil: sales[0]!.soldAt,
      }),
    ).resolves.toEqual([]);
    const weekly = await listProviderWeeklySaleBuckets(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      weekStartSince: "2026-08-01",
      asOf: "2026-09-02T00:00:00.000Z",
    });
    expect(weekly).toEqual([
      expect.objectContaining({
        externalKey: "sku:9001",
        weekStart: "2026-08-25",
        catalogProductKey: "cat_synthetic::",
        transactionCount: 3,
      }),
    ]);
    await expect(
      listProviderWeeklySaleBuckets(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        weekStartSince: "2026-08-26",
        asOf: "2026-09-02T00:00:00.000Z",
      }),
    ).resolves.toEqual([]);
    await expect(
      listProviderWeeklySaleBuckets(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        weekStartSince: "2026-08-01",
        asOf: "2026-09-01T14:59:59.000Z",
      }),
    ).resolves.toEqual([]);
    await expect(
      latestProviderMarketCapture(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        asOf: "2026-09-01T14:59:59.000Z",
      }),
    ).resolves.toBeNull();
    const latest = await latestProviderMarketCapture(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      asOf: "2026-09-02T00:00:00.000Z",
    });
    expect(latest).toMatchObject({
      outcomeKind: "recorded",
      signalPolicyRevisionId: "synthetic-signal-r1",
      observationPolicyRevisionId: "synthetic-observation-r1",
    });
    const groups = await listProviderListingAskGroups(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      captureId: latest!.captureId,
    });
    expect(groups).toHaveLength(3);
    expect(groups.every((row) => row.captureId === latest!.captureId && row.coverage === "complete")).toBe(true);
    const depth = await listProviderListingAskDepth(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      captureId: latest!.captureId,
    });
    expect(depth).toMatchObject({ captureId: latest!.captureId, coverage: "complete" });
    expect(depth.product).toEqual([
      { deliveredAmount: "5.00", cumulativeSellerCount: 1 },
      { deliveredAmount: "6.00", cumulativeSellerCount: 2 },
      { deliveredAmount: "7.00", cumulativeSellerCount: 3 },
    ]);
    await expect(
      listProviderListingSnapshots(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        observedSince: "2026-09-01",
        observedUntil: "2026-09-02",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ observedOn: "2026-09-01", coverage: "complete", captureId: latest!.captureId }),
    ]);
    await expect(
      listProviderListingSnapshots(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        observedSince: "2026-09-02",
      }),
    ).resolves.toEqual([]);
    await expect(
      listProviderListingAskGroups(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        captureId: "synthetic-missing-capture",
      }),
    ).resolves.toEqual([]);
    await expect(
      countProviderCompetingSellersAt(pool, {
        providerKey: "tcgplayer",
        catalogItemId: "cat_synthetic",
        captureId: latest!.captureId,
        deliveredAmount: "10.00",
      }),
    ).resolves.toEqual({ count: 3, coverage: "complete" });
  });

  it("round-trips complete and unknown sale captures without adding occurrences", async () => {
    let captureNumber = 0;
    const run = createTcgplayerMarketCapture({
      pool,
      transport: providerFixtureTransport(() =>
        ++captureNumber === 1 ? { validCount: 2, rejectedSibling: false } : { validCount: 3, rejectedSibling: true },
      ),
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
      resolveObservationPolicy: async () => ({
        revisionId: "synthetic-observation-r1",
        value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 1 },
      }),
      resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
      recordTcgplayerPriceSignal: async () => ({
        status: "unresolved",
        reason: "sku-reference-not-mapped",
        externalKey: "sku:9001",
      }),
    });
    await expect(run()).resolves.toMatchObject({ status: "completed", capturesCommitted: 1 });
    await expect(run()).resolves.toMatchObject({ status: "completed", capturesCommitted: 1 });
    expect(captureNumber).toBe(2);

    const persisted = await pool.query<{
      capture_id: string;
      capture_started_at: string;
      sales_coverage: string;
      rejected_rows: number;
    }>(
      `SELECT capture_id, capture_started_at::text, sales_coverage, rejected_row_count AS rejected_rows
       FROM pricing_external_market_captures ORDER BY capture_started_at`,
    );
    expect(persisted.rows.map(({ sales_coverage, rejected_rows }) => ({ sales_coverage, rejected_rows }))).toEqual([
      { sales_coverage: "complete", rejected_rows: 0 },
      { sales_coverage: "unknown", rejected_rows: 1 },
    ]);
    const sales = await pool.query<{
      capture_id: string;
      sale_fingerprint: string;
      observed_occurrence_count: number;
    }>(
      `SELECT capture_id, sale_fingerprint, observed_occurrence_count
       FROM pricing_external_sale_observations ORDER BY capture_id`,
    );
    expect(sales.rows).toHaveLength(2);
    expect(sales.rows.map((row) => row.observed_occurrence_count).sort()).toEqual([2, 3]);
    expect(sales.rows[0]?.sale_fingerprint).toBe(sales.rows[1]?.sale_fingerprint);
    const evidence = await listProviderSaleEvidence(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      soldSince: "2026-08-01T00:00:00.000Z",
    });
    expect(evidence).toEqual([
      {
        saleFingerprint: sales.rows[0]!.sale_fingerprint,
        providerCondition: "Near Mint",
        providerVariant: "Normal",
        providerLanguage: "English",
        listingType: "ListingWithoutPhotos",
        soldAt: "2026-08-31 12:00:00+00",
        quantity: 1,
        unitPrice: "5.39",
        orderShipping: "1.00",
        maxObservedTupleMultiplicity: 3,
        countSemantics: "provider-returned-max-per-capture",
        captureIds: persisted.rows.map((row) => row.capture_id),
        captureStartedAt: persisted.rows[1]!.capture_started_at,
        currency: "usd",
        policyRevisionId: "synthetic-observation-r1",
        coverage: "unknown",
      },
    ]);
  });
});

function providerFixtureTransport(
  salesForCapture: () => Readonly<{ validCount: number; rejectedSibling: boolean }> = () => ({
    validCount: 2,
    rejectedSibling: false,
  }),
): TcgplayerMarketTransport {
  const sale = {
    condition: "Near Mint",
    variant: "Normal",
    language: "English",
    quantity: 1,
    title: "synthetic",
    listingType: "ListingWithoutPhotos",
    customListingId: "synthetic-transient",
    purchasePrice: 5.39,
    shippingPrice: 1,
    orderDate: "2026-08-31T12:00:00.000Z",
  };
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
    mpApi: {
      post: async <T>() => {
        const { validCount, rejectedSibling } = salesForCapture();
        const data = [
          ...Array.from({ length: validCount }, () => sale),
          ...(rejectedSibling ? [{ ...sale, quantity: "invalid" }] : []),
        ];
        return { previousPage: "", nextPage: "", resultCount: data.length, totalResults: data.length, data } as T;
      },
    },
    mpSearchApi: {
      post: async <T>() =>
        ({
          errors: [],
          results: [
            {
              totalResults: 3,
              resultId: "synthetic",
              aggregations: {},
              results: [listing("synthetic-a", 5, 1), listing("synthetic-b", 6, 2), listing("synthetic-c", 7, 3)],
            },
          ],
        }) as T,
    },
    infiniteApi: {
      get: async <T>() =>
        ({
          count: 1,
          result: [
            {
              skuId: "9001",
              variant: "Normal",
              language: "English",
              condition: "Near Mint",
              averageDailyQuantitySold: "1",
              averageDailyTransactionCount: "1",
              totalQuantitySold: "3",
              totalTransactionCount: "3",
              trendingMarketPricePercentages: {},
              buckets: [
                {
                  marketPrice: "10.00",
                  quantitySold: "3",
                  lowSalePrice: "9.00",
                  lowSalePriceWithShipping: "9.50",
                  highSalePrice: "11.00",
                  highSalePriceWithShipping: "11.50",
                  transactionCount: "3",
                  bucketStartDate: "2026-08-25T00:00:00.000Z",
                },
              ],
            },
          ],
        }) as T,
    },
  };
}

function listing(sellerKey: string, price: number, listingId: number) {
  return {
    directProduct: false,
    goldSeller: false,
    listingId,
    channelId: 0,
    conditionId: 1,
    verifiedSeller: true,
    directInventory: 0,
    rankedShippingPrice: 0,
    productId: 7001,
    printing: "Normal",
    languageAbbreviation: "EN",
    sellerName: "synthetic",
    forwardFreight: false,
    sellerShippingPrice: 0,
    language: "English",
    shippingPrice: 0,
    condition: "Near Mint",
    languageId: 1,
    score: 0,
    directSeller: false,
    productConditionId: 1,
    sellerId: sellerKey,
    listingType: "standard",
    sellerRating: 100,
    sellerSales: "1",
    quantity: 1,
    sellerKey,
    price,
    customData: { images: [] },
  };
}

function clock() {
  let value = Date.parse("2026-09-01T14:59:59.000Z");
  return () => new Date((value += 1_000)).toISOString();
}
