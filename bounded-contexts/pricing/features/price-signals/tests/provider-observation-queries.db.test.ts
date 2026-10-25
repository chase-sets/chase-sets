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
import { captureSourceMutants, expectSourceMutantRed } from "./source-mutant-test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const providerObservationQueries = {
  countProviderCompetingSellersAt,
  latestProviderMarketCapture,
  listProviderListingAskDepth,
  listProviderListingAskGroups,
  listProviderListingSnapshots,
  listProviderWeeklySaleBuckets,
};
type ProviderObservationQueries = typeof providerObservationQueries;

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

  it("orders exact weekly, snapshot and capture-scoped ask shapes despite reverse inserts and reused ordinals", async () => {
    await orderingScenario(pool, providerObservationQueries);
  });

  it.each([
    ["groupOrderAmountFirst", "F7:groups"],
    ["groupOrderOrdinalFirst", "F7:groups"],
    ["weeklyOrderReversed", "F7:weekly"],
    ["snapshotOrderReversed", "F7:snapshots"],
    ["captureFilterRemoved", "F7:groups"],
    ["competingCountRows", "F7:counts"],
    ["productHistogramRows", "F7:depth"],
  ] as const)("turns the frozen query shapes red under the %s mutant", async (key, label) => {
    await expectSourceMutantRed<ProviderObservationQueries>(
      captureSourceMutants[key],
      "read-model/provider-observation-queries.ts",
      [label],
      (mutant) => orderingScenario(pool, mutant),
    );
  });
});

async function orderingScenario(pool: PgTransactionalPool, queries: ProviderObservationQueries) {
  const headers = [
    ["synthetic-query-day2", "2026-09-02T15:00:00.000Z"],
    ["synthetic-query-day1", "2026-09-01T15:00:00.000Z"],
  ] as const;
  for (const [id, instant] of headers) {
    await pool.query(
      `INSERT INTO pricing_external_market_captures
        (capture_id,provider_key,catalog_item_id,external_key,signal_pass_started_at,signal_policy_revision_id,
         products_per_pass,capture_started_at,capture_completed_at,authenticated_request,recorded_signal_count,
         unresolved_signal_count,outcome_kind,rejected_row_count,listings_status,listings_coverage)
        VALUES ($1,'tcgplayer','cat_synthetic','product:7001',$2,'synthetic-signal-r1',1,$2,$2,true,1,0,'recorded',0,'observed','complete')`,
      [id, instant],
    );
  }
  for (const [sku, week] of [
    [9002, "2026-09-01"],
    [9002, "2026-08-25"],
    [9001, "2026-09-01"],
    [9001, "2026-08-25"],
  ] as const) {
    await pool.query(
      `INSERT INTO pricing_external_weekly_sale_buckets
        (provider_key,external_key,catalog_item_id,catalog_product_key,week_start,provider_condition,provider_variant,
         provider_language,transaction_count,quantity_sold,last_capture_id,last_observed_at,updated_at)
        VALUES ('tcgplayer',$1,'cat_synthetic',NULL,$2,'Near Mint','Normal','English',1,1,'synthetic-query-day2','2026-09-02T15:00:00Z','2026-09-02T15:00:00Z')`,
      [`sku:${sku}`, week],
    );
  }
  const weekly = await queries.listProviderWeeklySaleBuckets(pool, {
    providerKey: "tcgplayer",
    catalogItemId: "cat_synthetic",
    weekStartSince: "2026-08-01",
    asOf: "2026-09-03T00:00:00Z",
  });
  expect(weekly, "F7:weekly").toEqual(
    [9001, 9002].flatMap((sku) =>
      ["2026-08-25", "2026-09-01"].map((week) => ({
        externalKey: `sku:${sku}`,
        weekStart: week,
        catalogProductKey: null,
        providerCondition: "Near Mint",
        providerVariant: "Normal",
        providerLanguage: "English",
        transactionCount: 1,
        quantitySold: 1,
        lowSaleAmount: null,
        highSaleAmount: null,
        lowDeliveredAmount: null,
        highDeliveredAmount: null,
        providerMarketAmount: null,
        captureId: "synthetic-query-day2",
        observedAt: "2026-09-02 15:00:00+00",
      })),
    ),
  );
  for (const [day, id] of [
    ["2026-09-02", "synthetic-query-day2"],
    ["2026-09-01", "synthetic-query-day1"],
  ] as const) {
    for (const [variant, language, condition] of [
      ["B", "English", "B"],
      ["A", "French", "A"],
      ["A", "English", "B"],
      ["A", "English", "A"],
    ] as const) {
      await pool.query(
        `INSERT INTO pricing_external_listing_snapshots
          (provider_key,catalog_item_id,provider_variant,provider_language,provider_condition,observed_on,
           distinct_seller_count,last_capture_id,last_observed_at,updated_at)
          VALUES ('tcgplayer','cat_synthetic',$1,$2,$3,$4,1,$5,$6,$6)`,
        [variant, language, condition, day, id, `${day}T15:00:00Z`],
      );
    }
  }
  const snapshots = await queries.listProviderListingSnapshots(pool, {
    providerKey: "tcgplayer",
    catalogItemId: "cat_synthetic",
    observedSince: "2026-09-01",
  });
  expect(snapshots, "F7:snapshots").toEqual(
    ["2026-09-01", "2026-09-02"].flatMap((day, index) =>
      [
        ["A", "English", "A"],
        ["A", "English", "B"],
        ["A", "French", "A"],
        ["B", "English", "B"],
      ].map(([variant, language, condition]) => ({
        observedOn: day,
        providerVariant: variant,
        providerLanguage: language,
        providerCondition: condition,
        distinctSellerCount: 1,
        cheapestDeliveredAmount: null,
        secondCheapestDeliveredAmount: null,
        captureId: headers[1 - index]![0],
        observedAt: `${day} 15:00:00+00`,
        coverage: "complete",
      })),
    ),
  );
  // Reverse-inserted and tie-discriminating: condition, amount and ordinal
  // disagree pairwise, ordinal 1 lists in both conditions, and ordinals 1
  // and 3 tie on B/5.00, so any other order or dropped key changes a shape.
  for (const [id, ordinal, condition, amount] of [
    ["synthetic-query-day2", 3, "B", "5.00"],
    ["synthetic-query-day2", 1, "B", "5.00"],
    ["synthetic-query-day2", 1, "A", "7.00"],
    ["synthetic-query-day2", 2, "A", "4.00"],
    ["synthetic-query-day1", 1, "A", "1.00"],
  ] as const) {
    await pool.query(
      `INSERT INTO pricing_external_listing_ask_depth
        (capture_id,anonymous_capture_seller_ordinal,provider_condition,delivered_amount,coverage)
        VALUES ($1,$2,$3,$4,'complete')`,
      [id, ordinal, condition, amount],
    );
  }
  const params = { providerKey: "tcgplayer", catalogItemId: "cat_synthetic", captureId: "synthetic-query-day2" };
  expect(await queries.listProviderListingAskGroups(pool, params), "F7:groups").toEqual(
    (
      [
        [2, "A", "4.00"],
        [1, "A", "7.00"],
        [1, "B", "5.00"],
        [3, "B", "5.00"],
      ] as const
    ).map(([ordinal, condition, amount]) => ({
      captureId: params.captureId,
      anonymousCaptureSellerOrdinal: ordinal,
      providerCondition: condition,
      deliveredAmount: amount,
      coverage: "complete",
    })),
  );
  // Distinct capture ordinals, not rows: at 7.00 ordinal 1 lists in both
  // conditions, so a row count reads 4 where three sellers compete.
  expect(
    [
      await queries.countProviderCompetingSellersAt(pool, { ...params, deliveredAmount: "5.00" }),
      await queries.countProviderCompetingSellersAt(pool, { ...params, deliveredAmount: "7.00" }),
      await queries.countProviderCompetingSellersAt(pool, {
        ...params,
        deliveredAmount: "5.00",
        providerCondition: "B",
      }),
      await queries.countProviderCompetingSellersAt(pool, {
        ...params,
        deliveredAmount: "7.00",
        providerCondition: "A",
      }),
    ],
    "F7:counts",
  ).toEqual([
    { count: 3, coverage: "complete" },
    { count: 3, coverage: "complete" },
    { count: 2, coverage: "complete" },
    { count: 2, coverage: "complete" },
  ]);
  expect(await queries.listProviderListingAskDepth(pool, params), "F7:depth").toEqual({
    captureId: params.captureId,
    coverage: "complete",
    conditions: [
      {
        providerCondition: "A",
        points: [
          { deliveredAmount: "4.00", cumulativeSellerCount: 1 },
          { deliveredAmount: "7.00", cumulativeSellerCount: 2 },
        ],
      },
      { providerCondition: "B", points: [{ deliveredAmount: "5.00", cumulativeSellerCount: 2 }] },
    ],
    product: [
      { deliveredAmount: "4.00", cumulativeSellerCount: 1 },
      { deliveredAmount: "5.00", cumulativeSellerCount: 3 },
      { deliveredAmount: "7.00", cumulativeSellerCount: 3 },
    ],
  });
  await pool.query(`INSERT INTO pricing_external_market_captures
      (capture_id,provider_key,catalog_item_id,external_key,signal_pass_started_at,signal_policy_revision_id,
       products_per_pass,capture_started_at,capture_completed_at,authenticated_request,recorded_signal_count,
       unresolved_signal_count,outcome_kind,rejected_row_count,listings_status,listings_coverage)
      VALUES ('synthetic-query-empty','tcgplayer','cat_synthetic','product:7001','2026-09-03T15:00:00Z',
      'synthetic-signal-r1',1,'2026-09-03T15:00:00Z','2026-09-03T15:00:00Z',true,1,0,'recorded',0,'observed','complete')`);
  expect(
    await queries.latestProviderMarketCapture(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      asOf: "2026-09-04T00:00:00Z",
    }),
  ).toMatchObject({
    captureId: "synthetic-query-empty",
    endpoints: { listings: { status: "observed", coverage: "complete" } },
  });
  expect(
    await queries.latestProviderMarketCapture(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      asOf: "2026-08-31T00:00:00Z",
    }),
  ).toBeNull();
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
