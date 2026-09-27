import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import { createObjectStorageTcgplayerMarketCaptureReceiptSink } from "../integrations/tcgplayer/capture-sanitizer";
import { createTcgplayerMarketClient } from "../integrations/tcgplayer/market-client";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";
import { listProviderListingAskGroups } from "../read-model/provider-observation-queries";
import {
  commitProviderObservationCapture,
  selectMarketCaptureSignalWork,
} from "../read-model/provider-observation-writes";
import { captureSourceMutants, expectSourceMutantRed, settled } from "./source-mutant-test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

type CreateCapture = typeof createTcgplayerMarketCapture;
type CaptureModule = Readonly<{ createTcgplayerMarketCapture: CreateCapture }>;
const captureEntry = "api/market-capture.ts";
const invalidSaleClasses = [
  [
    "non-array complete envelope",
    { previousPage: "", nextPage: "", resultCount: 0, totalResults: 0, data: "not-an-array" },
    true,
  ],
  [
    "nested owned key",
    salesPage({ total: 2, rows: [sale(1), { ...sale(2), ownedUnknown: "C12_NESTED_SECRET" }] }),
    false,
  ],
  ["fractional quantity", salesPage({ total: 2, rows: [sale(1), { ...sale(2), quantity: 1.5 }] }), false],
  ["SQL integer overflow", salesPage({ total: 2, rows: [sale(1), { ...sale(2), quantity: 2147483648 }] }), false],
  ["three-decimal money", salesPage({ total: 2, rows: [sale(1), { ...sale(2), purchasePrice: 5.001 }] }), false],
  ["invalid instant", salesPage({ total: 2, rows: [sale(1), { ...sale(2), orderDate: "not-an-instant" }] }), false],
  ["terminal quantity zero", salesPage({ total: 2, rows: [sale(1), { ...sale(2), quantity: 0 }] }), false],
] as const;
const rowRejectionClasses = invalidSaleClasses.filter(([, , envelopeInvalid]) => !envelopeInvalid);

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

  it("rejects one malformed listing component while persisting valid sale, listing and history siblings", async () => {
    await malformedListingScenario(pool, createTcgplayerMarketCapture);
  });

  it("turns the malformed-listing outcome red when rejections are recorded as a clean capture", async () => {
    await expectSourceMutantRed<CaptureModule>(
      captureSourceMutants.outcomeBypass,
      captureEntry,
      ["F5:listing-header"],
      (mutant) => malformedListingScenario(pool, mutant.createTcgplayerMarketCapture),
    );
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

  it("commits a valid sibling without retaining an invalid sale or its private marker", async () => {
    const privateMarker = "C12_REJECTED_CUSTOM_LISTING_SECRET";
    await runCapture(pool, [
      salesPage({
        total: 2,
        rows: [sale(1), { ...sale(2), orderDate: "not-an-instant", customListingId: privateMarker }],
      }),
    ]);
    const header = await pool.query<{
      outcome_kind: string;
      rejected_row_count: number;
      sales_status: string;
      sales_coverage: string;
      sales_returned_count: number;
    }>(`SELECT outcome_kind, rejected_row_count, sales_status, sales_coverage,
               sales_returned_count FROM pricing_external_market_captures`);
    expect(header.rows).toEqual([
      expect.objectContaining({
        outcome_kind: "recorded-with-rejections",
        rejected_row_count: 1,
        sales_status: "observed",
        sales_coverage: "unknown",
        sales_returned_count: 1,
      }),
    ]);
    const rows = await pool.query<{ observed_occurrence_count: number; unit_price: string }>(
      "SELECT observed_occurrence_count, unit_price::text FROM pricing_external_sale_observations",
    );
    expect(rows.rows).toEqual([{ observed_occurrence_count: 1, unit_price: "6.00" }]);
    const cursor = await pool.query<{ after_external_key: string; generation: string }>(
      "SELECT after_external_key, generation::text FROM pricing_external_market_capture_cursors",
    );
    expect(cursor.rows).toEqual([{ after_external_key: "", generation: "1" }]);
    expect(JSON.stringify({ header: header.rows, rows: rows.rows, cursor: cursor.rows })).not.toContain(privateMarker);
  });

  it.each(invalidSaleClasses)(
    "isolates %s through runtime, decoder and durable write",
    async (_label, response, envelopeInvalid) => {
      await saleClassScenario(pool, createTcgplayerMarketCapture, response, envelopeInvalid);
    },
  );

  it.each(invalidSaleClasses)(
    "turns %s red when the strict sales decoders accept input unchanged",
    async (_label, response, envelopeInvalid) => {
      await expectSourceMutantRed<CaptureModule>(
        captureSourceMutants.decoderBypass,
        captureEntry,
        ["F5:run-result", "F5:class-header", "F5:class-sales"],
        (mutant) => saleClassScenario(pool, mutant.createTcgplayerMarketCapture, response, envelopeInvalid),
      );
    },
  );

  it.each(rowRejectionClasses)(
    "turns %s red when rejections are recorded as a clean capture",
    async (_label, response, envelopeInvalid) => {
      await expectSourceMutantRed<CaptureModule>(
        captureSourceMutants.outcomeBypass,
        captureEntry,
        ["F5:class-header"],
        (mutant) => saleClassScenario(pool, mutant.createTcgplayerMarketCapture, response, envelopeInvalid),
      );
    },
  );

  it("binds transport arguments, non-USD provenance, local ceiling, annual range and closed hostile diagnostics", async () => {
    await hostileTransportScenario(pool, createTcgplayerMarketCapture);
  });

  it.each([
    ["lostCurrency", ["F2:header"]],
    ["ignoredCeiling", ["F2:calls", "F2:header"]],
    ["receiptLeak", ["F2:marker"]],
  ] as const)("turns the hostile-transport proof red under the %s mutant", async (key, labels) => {
    await expectSourceMutantRed<CaptureModule>(captureSourceMutants[key], captureEntry, labels, (mutant) =>
      hostileTransportScenario(pool, mutant.createTcgplayerMarketCapture),
    );
  });

  it("persists the synthetic injected-client own-seller control without claiming runtime wiring", async () => {
    const policy = {
      ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
      capturesPerPass: 1,
      listings: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings, pageBudget: 1 },
    };
    const transportWithOwnSeller: TcgplayerMarketTransport = {
      mpGateway: { post: async <T>() => [pricePoint()] as T },
      mpApi: { post: async <T>() => salesPage({ total: 0, rows: [] }) as T },
      mpSearchApi: {
        post: async <T>() =>
          ({
            errors: [],
            results: [
              {
                totalResults: 2,
                resultId: "synthetic",
                aggregations: {},
                results: [listing("synthetic-own-seller", 4), listing("synthetic-other", 5)],
              },
            ],
          }) as T,
      },
      infiniteApi: { get: async <T>() => ({ count: 0, result: [] }) as T },
    };
    const work = await selectMarketCaptureSignalWork(pool, "tcgplayer", 1);
    expect(work).toHaveLength(1);
    const fetched = await createTcgplayerMarketClient(transportWithOwnSeller).fetchSecondary({
      productId: 7001,
      policy,
      ownSellerKey: "synthetic-own-seller",
      now: clock(),
    });
    expect(fetched.observation.listings).toMatchObject({ ownSellerExclusionApplied: true, returnedCount: 1 });
    const capture = mapProviderObservationCapture({
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      productExternalKey: "product:7001",
      catalogProductKeysBySku: new Map([[9001, "cat_synthetic::"]]),
      signalPassStartedAt: "2026-09-01T15:00:00.000Z",
      captureStartedAt: "2026-09-01T15:00:02.000Z",
      captureCompletedAt: "2026-09-01T15:00:08.000Z",
      signalPolicy: { revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } },
      observationPolicy: { revisionId: "synthetic-observation-r1", value: policy },
      statHygienePolicyRevisionId: "synthetic-stat-r1",
      authenticatedRequest: true,
      recordedSignalCount: 1,
      unresolvedSignalCount: 0,
      observation: fetched.observation,
    });
    expect(await commitProviderObservationCapture(pool, "tcgplayer", work[0]!, capture)).toBe("committed");
    const header = await pool.query<{ own_seller_exclusion_applied: boolean; listings_returned_count: number }>(
      "SELECT own_seller_exclusion_applied, listings_returned_count FROM pricing_external_market_captures",
    );
    expect(header.rows).toEqual([{ own_seller_exclusion_applied: true, listings_returned_count: 1 }]);
    const groups = await listProviderListingAskGroups(pool, {
      providerKey: "tcgplayer",
      catalogItemId: "cat_synthetic",
      captureId: capture.header.captureId,
    });
    expect(groups).toEqual([expect.objectContaining({ captureId: capture.header.captureId, deliveredAmount: "5.00" })]);
  });
});

async function runCapture(
  pool: PgTransactionalPool,
  pages: readonly unknown[],
  salesPolicy: Readonly<{ pageSize?: number; pageBudget?: number; limit?: number }> = {},
  otherEndpoints = false,
  invalidListing = false,
  create: CreateCapture = createTcgplayerMarketCapture,
) {
  let page = 0;
  const run = create({
    pool,
    transport: transport(
      () => {
        const value = pages[page++];
        if (value === undefined) throw Object.assign(new Error("synthetic-unavailable-secret"), { status: 503 });
        return value;
      },
      otherEndpoints,
      invalidListing,
    ),
    receiptSink: { kind: "not-mounted" },
    now: clock(),
    resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
    resolveObservationPolicy: async () => ({
      revisionId: "synthetic-observation-r1",
      value: {
        ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
        capturesPerPass: 1,
        sales: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales, ...salesPolicy },
        listings: {
          ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings,
          pageBudget: invalidListing ? 1 : PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings.pageBudget,
        },
      },
    }),
    resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
    recordTcgplayerPriceSignal: async () => ({
      status: "unresolved",
      reason: "sku-reference-not-mapped",
      externalKey: "sku:9001",
    }),
  });
  expect(await settled(run()), "F5:run-result").toMatchObject({ status: "completed", capturesCommitted: 1 });
}

async function malformedListingScenario(pool: PgTransactionalPool, create: CreateCapture) {
  await runCapture(pool, [salesPage({ total: 1, rows: [sale(1)] })], {}, true, true, create);
  const header = await pool.query<{
    outcome_kind: string;
    rejected_row_count: number;
    sales_status: string;
    listings_status: string;
    history_status: string;
    listings_coverage: string;
  }>(
    "SELECT outcome_kind, rejected_row_count, sales_status, listings_status, history_status, listings_coverage FROM pricing_external_market_captures",
  );
  expect(header.rows, "F5:listing-header").toEqual([
    {
      outcome_kind: "recorded-with-rejections",
      rejected_row_count: 1,
      sales_status: "observed",
      listings_status: "observed",
      history_status: "observed",
      listings_coverage: "page-budget-truncated",
    },
  ]);
  for (const table of [
    "pricing_external_sale_observations",
    "pricing_external_weekly_sale_buckets",
    "pricing_external_listing_ask_depth",
  ]) {
    expect((await pool.query(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
  }
  expect(
    (await pool.query<{ generation: string }>("SELECT generation::text FROM pricing_external_market_capture_cursors"))
      .rows,
  ).toEqual([{ generation: "1" }]);
}

async function saleClassScenario(
  pool: PgTransactionalPool,
  create: CreateCapture,
  response: unknown,
  envelopeInvalid: boolean,
) {
  const logs: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  try {
    await runCapture(pool, [response], {}, true, false, create);
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
  const header = await pool.query<{
    outcome_kind: string;
    rejected_row_count: number;
    sales_status: string;
    sales_coverage: string;
    sales_returned_count: number;
    history_status: string;
  }>(
    "SELECT outcome_kind, rejected_row_count, sales_status, sales_coverage, sales_returned_count, history_status FROM pricing_external_market_captures",
  );
  expect(header.rows, "F5:class-header").toEqual([
    expect.objectContaining(
      envelopeInvalid
        ? {
            outcome_kind: "recorded",
            rejected_row_count: 0,
            sales_status: "unavailable",
            sales_coverage: "unknown",
            sales_returned_count: 0,
          }
        : {
            outcome_kind: "recorded-with-rejections",
            rejected_row_count: 1,
            sales_status: "observed",
            sales_coverage: "unknown",
            sales_returned_count: 1,
          },
    ),
  ]);
  const sales = await pool.query<{ unit_price: string; quantity: number }>(
    "SELECT unit_price::text, quantity FROM pricing_external_sale_observations",
  );
  expect(sales.rows, "F5:class-sales").toEqual(envelopeInvalid ? [] : [{ unit_price: "6.00", quantity: 1 }]);
  expect(header.rows[0]!.history_status).toBe("observed");
  expect((await pool.query("SELECT * FROM pricing_external_weekly_sale_buckets")).rows).toHaveLength(1);
  expect((await pool.query("SELECT * FROM pricing_external_listing_ask_depth")).rows).toHaveLength(1);
  const cursor = await pool.query<{ after_external_key: string; generation: string }>(
    "SELECT after_external_key, generation::text FROM pricing_external_market_capture_cursors",
  );
  expect(cursor.rows).toEqual([{ after_external_key: "", generation: "1" }]);
  const durable = JSON.stringify({ header: header.rows, sales: sales.rows, cursor: cursor.rows, logs });
  expect(durable).not.toMatch(/C12_(?:NESTED|SYNTHETIC|EXCEPTION)_SECRET/);
}

function transport(
  nextSalesPage: () => unknown,
  otherEndpoints = false,
  invalidListing = false,
): TcgplayerMarketTransport {
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
        if (otherEndpoints)
          return {
            errors: [],
            results: [
              {
                totalResults: invalidListing ? 2 : 1,
                resultId: "synthetic",
                aggregations: {},
                results: [
                  listing("synthetic-valid-seller", 4),
                  ...(invalidListing
                    ? [{ ...listing("synthetic-invalid-seller", 5), customData: { images: [123] } }]
                    : []),
                ],
              },
            ],
          } as T;
        throw new Error("synthetic-listings-unavailable") as T;
      },
    },
    infiniteApi: {
      get: async <T>() => {
        if (otherEndpoints)
          return {
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
          } as T;
        throw new Error("synthetic-history-unavailable") as T;
      },
    },
  };
}

function salesPage(
  input: Readonly<{
    total: number;
    rows: readonly unknown[];
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
    listingType: "ListingWithoutPhotos",
    customListingId: `synthetic-${index}`,
    purchasePrice: 5 + index,
    shippingPrice: 0,
    orderDate: `2026-09-0${index}T00:00:00.000Z`,
  };
}

function pricePoint() {
  return {
    skuId: 9001,
    marketPrice: 10,
    lowestPrice: 9,
    highestPrice: 11,
    priceCount: 3,
    calculatedAt: "2026-09-01T15:00:00.000Z",
  };
}

function listing(sellerKey: string, price: number) {
  return {
    directProduct: false,
    goldSeller: false,
    listingId: 1,
    channelId: 0,
    conditionId: 1,
    verifiedSeller: true,
    directInventory: 0,
    rankedShippingPrice: 0,
    productId: 7001,
    printing: "Normal",
    languageAbbreviation: "EN",
    sellerName: "C12_SELLER_NAME_SECRET",
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

async function hostileTransportScenario(pool: PgTransactionalPool, create: CreateCapture) {
  const calls: Array<{ endpoint: string; path: string; body: unknown }> = [];
  const logs: string[] = [];
  const artifacts: string[] = [];
  let salesPageIndex = 0;
  const pages = [
    salesPage({ total: 2, rows: [sale(1)], nextPage: "Yes" }),
    salesPage({ total: 2, rows: [sale(2)], previousPage: "Yes" }),
  ];
  const transportWithFacts: TcgplayerMarketTransport = {
    mpGateway: { post: async <T>() => [pricePoint()] as T },
    mpApi: {
      post: async <T>(path: string, body?: unknown) => {
        calls.push({ endpoint: "sales", path, body });
        return pages[salesPageIndex++] as T;
      },
    },
    mpSearchApi: {
      post: async <T>(path: string, body?: unknown) => {
        calls.push({ endpoint: "listings", path, body });
        return {
          errors: [],
          results: [
            {
              totalResults: 3,
              resultId: "synthetic",
              aggregations: {},
              results: [listing("synthetic-own-seller", 4), listing("synthetic-other", 8)],
            },
          ],
        } as T;
      },
    },
    infiniteApi: {
      get: async <T>(path: string, params?: Readonly<Record<string, string | number | boolean | null | undefined>>) => {
        calls.push({ endpoint: "history", path, body: params });
        throw Object.assign(new Error("C12_EXCEPTION_SECRET_history"), { status: 503 }) as T;
      },
    },
  };
  const sink = createObjectStorageTcgplayerMarketCaptureReceiptSink({
    putObject: async (input) => {
      expect(input.visibility).toBe("private");
      artifacts.push(new TextDecoder().decode(input.body));
    },
  });
  const consoleSpies = (["log", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args) => {
      logs.push(args.join(" "));
    }),
  );
  const result = await settled(
    create({
      pool,
      transport: transportWithFacts,
      receiptSink: sink,
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
      resolveObservationPolicy: async () => ({
        revisionId: "synthetic-observation-r1",
        value: {
          ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
          currency: "cad",
          capturesPerPass: 1,
          sales: {
            ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales,
            pageSize: 1,
            limit: 2,
            conditions: [1],
            languages: [2],
            variants: [3],
            listingType: "ListingWithoutPhotos",
          },
          listings: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings, pageSize: 2, deliveredCeiling: "5.00" },
        },
      }),
      resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
      recordTcgplayerPriceSignal: async () => ({
        status: "unresolved",
        reason: "sku-reference-not-mapped",
        externalKey: "sku:9001",
      }),
    })(),
  ).finally(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });
  expect(calls, "F2:calls").toEqual([
    {
      endpoint: "sales",
      path: "/v2/product/7001/latestsales",
      body: {
        conditions: [1],
        languages: [2],
        variants: [3],
        listingType: "ListingWithoutPhotos",
        offset: 0,
        limit: 1,
      },
    },
    {
      endpoint: "listings",
      path: "/v1/product/7001/listings",
      body: {
        aggregations: ["condition", "language", "listingType", "printing"],
        context: { shippingCountry: "US" },
        filters: { term: { "verified-seller": true } },
        from: 0,
        size: 2,
        sort: { field: "price+shipping", order: "asc" },
      },
    },
    { endpoint: "history", path: "/price/history/7001/detailed", body: { range: "annual" } },
    {
      endpoint: "sales",
      path: "/v2/product/7001/latestsales",
      body: {
        conditions: [1],
        languages: [2],
        variants: [3],
        listingType: "ListingWithoutPhotos",
        offset: 1,
        limit: 1,
      },
    },
  ]);
  expect(result, "F2:run").toMatchObject({ status: "completed", capturesCommitted: 1 });
  const header = (await pool.query<Record<string, unknown>>("SELECT * FROM pricing_external_market_captures")).rows[0]!;
  expect(header, "F2:header").toMatchObject({
    signal_policy_revision_id: "synthetic-signal-r1",
    products_per_pass: 1,
    observation_policy_revision_id: "synthetic-observation-r1",
    stat_hygiene_policy_revision_id: "synthetic-stat-r1",
    captures_per_pass: 1,
    currency: "cad",
    outcome_kind: "recorded",
    rejected_row_count: 0,
    sales_status: "observed",
    sales_coverage: "complete",
    sales_pages_fetched: 2,
    sales_returned_count: 2,
    sales_first_reported_total: 2,
    sales_last_reported_total: 2,
    sales_first_result_count: 1,
    sales_last_result_count: 1,
    sales_last_next_page: "",
    listings_status: "observed",
    listings_coverage: "ceiling-truncated",
    listings_pages_fetched: 1,
    listings_returned_count: 2,
    listings_reported_total: 3,
    own_seller_exclusion_applied: false,
    history_status: "unavailable",
    history_coverage: "unknown",
    history_result_count: 0,
    history_bucket_count: 0,
    history_response_observed_at: null,
    history_http_status_class: "5xx",
    history_range: "annual",
    request_posture: expect.objectContaining({
      salesConditions: [1],
      salesLanguages: [2],
      salesVariants: [3],
      salesListingType: "ListingWithoutPhotos",
      listingsDeliveredCeiling: "5.00",
      historyRange: "annual",
    }),
  });
  for (const endpoint of ["sales", "listings", "history"]) {
    expect(Date.parse(String(header[`${endpoint}_requested_at`]))).toBeGreaterThanOrEqual(
      Date.parse(String(header.capture_started_at)),
    );
  }
  for (const endpoint of ["sales", "listings"]) {
    expect(Date.parse(String(header[`${endpoint}_response_observed_at`]))).toBeGreaterThanOrEqual(
      Date.parse(String(header[`${endpoint}_requested_at`])),
    );
  }
  expect(Date.parse(String(header.signal_pass_started_at))).toBeLessThan(Date.parse(String(header.capture_started_at)));
  expect(Date.parse(String(header.capture_completed_at))).toBeGreaterThan(
    Date.parse(String(header.capture_started_at)),
  );
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]).toContain('"salesPages"');
  expect(artifacts[0]).toContain('"listingPages"');
  expect(artifacts[0]).toContain('"failurePhase": "transport"');
  const evidence: unknown[] = [header, logs, artifacts];
  for (const table of [
    "pricing_external_sale_observations",
    "pricing_external_weekly_sale_buckets",
    "pricing_external_listing_snapshots",
    "pricing_external_listing_ask_depth",
    "pricing_external_market_capture_cursors",
  ]) {
    evidence.push((await pool.query(`SELECT row_to_json(t) AS row FROM ${table} t`)).rows);
  }
  const serialized = JSON.stringify(evidence);
  const leakedMarkers = [
    "external-seller-secret",
    "C12_SELLER_ID_SECRET",
    "C12_SELLER_NAME_SECRET",
    "C12_SELLER_RATING_SECRET",
    "C12_SELLER_SALES_SECRET",
    "C12_SELLER_BADGES_SECRET",
    "C12_LISTING_ID_SECRET",
    "C12_CUSTOM_LISTING_ID_SECRET",
    "C12_LISTING_TITLE_SECRET",
    "C12_CUSTOM_TITLE_SECRET",
    "C12_CUSTOM_DATA_SECRET",
    "C12_COOKIE_SECRET",
    "C12_AUTH_SECRET",
    "C12_RESPONSE_SECRET",
    "C12_EXCEPTION_SECRET",
    "synthetic-own-seller",
    "synthetic-other",
  ].filter((marker) => serialized.includes(marker));
  expect(leakedMarkers, "F2:marker").toEqual([]);
}
