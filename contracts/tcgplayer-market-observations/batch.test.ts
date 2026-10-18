import { describe, expect, it } from "vitest";
import {
  canonicalizeTcgplayerMarketObservationBatch,
  parseTcgplayerMarketObservationBatch,
  parseTcgplayerMarketObservationRequest,
  TcgplayerMarketObservationContractError,
  type TcgplayerMarketObservationBatch,
  type TcgplayerMarketObservationRequest,
} from "./index";
import { sourceMutant, type Replacement } from "./mutants";

const T0 = "2026-10-17T00:00:00.000Z";
const T1 = "2026-10-17T00:00:01.000Z";
const requestId = "123e4567-e89b-12d3-a456-426614174000";
const posture = {
  salesOffset: 0,
  salesLimit: 2,
  salesPageSize: 1,
  salesPageBudget: 2,
  salesConditions: [],
  salesLanguages: [],
  salesVariants: [],
  salesListingType: "ListingWithoutPhotos" as const,
  listingsVerifiedOnly: true,
  listingsPageSize: 5,
  listingsPageBudget: 1,
  listingsDeliveredCeiling: "1000.00",
  historyRange: "annual" as const,
  timeoutMs: 1000,
};
// Derived caps for this posture: sales min(2, 1×2) = 2, listings 5×1 = 5,
// history rows 250, buckets per history row 53.
const SALES_CAP = 2;
const LISTINGS_CAP = 5;
const HISTORY_ROW_CAP = 250;
type Kind = "sales" | "listings" | "history";
type Status = "unavailable" | "not-requested";
const KINDS: Kind[] = ["sales", "listings", "history"];
const requestFor = (
  products: readonly Record<string, unknown>[],
  phase: "price-points" | "secondary" = "secondary",
  p: Record<string, unknown> = posture,
) =>
  parseTcgplayerMarketObservationRequest({
    contractVersion: 1,
    requestId,
    phase,
    issuedAt: T0,
    products,
    posture: phase === "secondary" ? p : null,
  });
const request = requestFor([{ productId: 1, skuIds: [1, 2], skuTargetCount: 2 }]);
const twoProductRequest = requestFor([
  { productId: 1, skuIds: [1], skuTargetCount: 1 },
  { productId: 2, skuIds: [1], skuTargetCount: 1 },
]);
const skuIds250 = Array.from({ length: 250 }, (_, i) => i + 1);
const wideRequest = requestFor([{ productId: 1, skuIds: skuIds250, skuTargetCount: 250 }]);
const pricePointsRequest = requestFor([{ productId: 1, skuIds: [1, 2], skuTargetCount: 2 }], "price-points");
const unavailableMetadata = (kind: Kind): Record<string, unknown> =>
  kind === "sales"
    ? {
        coverage: "unknown",
        pagesFetched: 0,
        returnedCount: 0,
        firstReportedTotal: null,
        lastReportedTotal: null,
        firstResultCount: null,
        lastResultCount: null,
        lastNextPage: null,
      }
    : kind === "listings"
      ? { coverage: "unknown", pagesFetched: 0, returnedCount: 0, reportedTotal: null }
      : { coverage: "unknown", resultCount: 0, bucketCount: 0 };
const endpoint = (kind: Kind, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "unavailable",
  httpStatusClass: "4xx",
  credentialsMode: "omit",
  requestedAt: T0,
  responseObservedAt: null,
  rejectedRows: 0,
  rows: [],
  ...unavailableMetadata(kind),
  ...overrides,
});
const notRequested = (kind: Kind, overrides: Record<string, unknown> = {}) =>
  endpoint(kind, {
    status: "not-requested",
    httpStatusClass: "none",
    credentialsMode: null,
    requestedAt: null,
    ...overrides,
  });
const observedMetadata = (kind: Kind, rows: readonly Record<string, unknown>[]): Record<string, unknown> =>
  kind === "sales"
    ? {
        coverage: "complete",
        pagesFetched: 1,
        returnedCount: Math.min(rows.length, SALES_CAP),
        firstReportedTotal: null,
        lastReportedTotal: null,
        firstResultCount: null,
        lastResultCount: null,
        lastNextPage: null,
      }
    : kind === "listings"
      ? {
          coverage: "complete",
          pagesFetched: 1,
          returnedCount: Math.min(rows.length, LISTINGS_CAP),
          reportedTotal: null,
        }
      : {
          coverage: "observed",
          resultCount: Math.min(rows.length, HISTORY_ROW_CAP),
          bucketCount: rows.reduce((n, row) => n + (row.buckets as unknown[]).length, 0),
        };
const observed = (kind: Kind, rows: readonly Record<string, unknown>[], overrides: Record<string, unknown> = {}) =>
  endpoint(kind, {
    status: "observed",
    httpStatusClass: "none",
    credentialsMode: "omit",
    requestedAt: T0,
    responseObservedAt: T1,
    rows,
    ...observedMetadata(kind, rows),
    ...overrides,
  });
const sale = (overrides: Record<string, unknown> = {}) => ({
  condition: "Near Mint",
  variant: "Normal",
  language: "English",
  listingType: "ListingWithoutPhotos",
  quantity: 1,
  purchasePrice: "1.00",
  shippingPrice: "0.00",
  orderDate: T0,
  ...overrides,
});
const listing = (sellerOrdinal = 1, overrides: Record<string, unknown> = {}) => ({
  sellerOrdinal,
  condition: "Near Mint",
  printing: "Normal",
  language: "English",
  price: "1.00",
  sellerShippingPrice: "0.00",
  ...overrides,
});
const bucket = (bucketStartDate = "2026-01-05", overrides: Record<string, unknown> = {}) => ({
  bucketStartDate,
  marketPrice: null,
  quantitySold: 1,
  transactionCount: 1,
  lowSalePrice: null,
  lowSalePriceWithShipping: null,
  highSalePrice: null,
  highSalePriceWithShipping: null,
  ...overrides,
});
const weekAt = (index: number) => new Date(Date.UTC(2026, 0, 5 + 7 * index)).toISOString().slice(0, 10);
const historyRow = (
  skuId = 1,
  buckets: readonly Record<string, unknown>[] = [],
  overrides: Record<string, unknown> = {},
) => ({
  skuId,
  variant: "Normal",
  language: "English",
  condition: "Near Mint",
  buckets,
  ...overrides,
});
const pricePoint = (skuId: number, overrides: Record<string, unknown> = {}) => ({
  skuId,
  marketPrice: null,
  lowestPrice: null,
  highestPrice: null,
  priceCount: null,
  calculatedAt: null,
  ...overrides,
});
const rowOf = (kind: Kind) => (kind === "sales" ? sale() : kind === "listings" ? listing() : historyRow());
const product = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  productId: 1,
  sales: endpoint("sales"),
  listings: endpoint("listings"),
  history: endpoint("history"),
  ...overrides,
});
const batch = (
  products: readonly Record<string, unknown>[] = [product()],
  req: TcgplayerMarketObservationRequest = request,
  envelope: Record<string, unknown> = {},
) =>
  JSON.stringify({
    contractVersion: 1,
    requestId: req.requestId,
    phase: req.phase,
    posture: req.posture,
    products,
    ...envelope,
  });
const errorCode = (fn: () => unknown) => {
  try {
    fn();
    return "accepted";
  } catch (error) {
    return error instanceof TcgplayerMarketObservationContractError ? error.code : "unknown";
  }
};
const codeOf = (text: string, req: TcgplayerMarketObservationRequest = request) =>
  errorCode(() => parseTcgplayerMarketObservationBatch(text, req));
const reverseKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(reverseKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .reverse()
            .map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

// B01: every matrix field set alone off-matrix for each non-observed status on each endpoint kind.
const offMatrixFields: Record<Kind, [field: string, value: unknown][]> = {
  sales: [
    ["pagesFetched", 1],
    ["returnedCount", 1],
    ["firstReportedTotal", 1],
    ["lastReportedTotal", 1],
    ["firstResultCount", 1],
    ["lastResultCount", 1],
    ["lastNextPage", "Yes"],
  ],
  listings: [
    ["pagesFetched", 1],
    ["returnedCount", 1],
    ["reportedTotal", 1],
  ],
  history: [
    ["resultCount", 1],
    ["bucketCount", 1],
  ],
};
const statusSpecific: Record<Status, [field: string, value: unknown][]> = {
  unavailable: [
    ["httpStatusClass", "none"],
    ["credentialsMode", null],
    ["requestedAt", null],
  ],
  "not-requested": [
    ["httpStatusClass", "4xx"],
    ["credentialsMode", "omit"],
    ["requestedAt", T0],
  ],
};
const b01: [name: string, status: Status, kind: Kind, change: Record<string, unknown>][] = (
  ["unavailable", "not-requested"] as Status[]
).flatMap((status) =>
  KINDS.flatMap((kind) =>
    (
      [
        ["rejectedRows", 1],
        ["rows", [rowOf(kind)]],
        ["coverage", kind === "history" ? "observed" : "complete"],
        ["responseObservedAt", T1],
        ...offMatrixFields[kind],
        ...statusSpecific[status],
      ] as [string, unknown][]
    ).map(([field, value]): [string, Status, Kind, Record<string, unknown>] => [
      `B01 ${status} ${kind} ${field}`,
      status,
      kind,
      { [field]: value },
    ]),
  ),
);

// Inputs with exactly one rule broken; each is shared by its B-case and its B21 mutant.
const unavailableOffMatrix = batch([product({ sales: endpoint("sales", { pagesFetched: 1 }) })]);
const observedNullResponse = batch([product({ sales: observed("sales", [], { responseObservedAt: null }) })]);
const observedEarlierResponse = batch([
  product({ sales: observed("sales", [], { responseObservedAt: "2026-10-16T23:59:59.000Z" }) }),
]);
const disabledStatus = batch([product({ sales: notRequested("sales", { status: "disabled" }) })]);
const endpointUnknownKey = batch([product({ sales: endpoint("sales", { extra: true }) })]);
const saleUnknownKey = batch([product({ sales: observed("sales", [sale({ extra: true })]) })]);
const listingUnknownKey = batch([product({ listings: observed("listings", [listing(1, { extra: true })]) })]);
const historyUnknownKey = batch([product({ history: observed("history", [historyRow(1, [], { extra: true })]) })]);
const bucketUnknownKey = batch([
  product({ history: observed("history", [historyRow(1, [bucket("2026-01-05", { extra: true })])]) }),
]);
const pricePointsCapPlus = batch(
  [{ productId: 1, pricePoints: [pricePoint(1), pricePoint(2), pricePoint(1)] }],
  pricePointsRequest,
);
const salesCapPlus = batch([product({ sales: observed("sales", [sale(), sale(), sale()]) })]);
const listingsCapPlus = batch([
  product({
    listings: observed(
      "listings",
      [1, 1, 1, 1, 1, 1].map((o) => listing(o)),
    ),
  }),
]);
const historyRowsCapPlus = batch(
  [
    product({
      history: observed(
        "history",
        [...skuIds250, 1].map((skuId) => historyRow(skuId)),
      ),
    }),
  ],
  wideRequest,
);
const bucketsCapPlus = batch([
  product({
    history: observed("history", [
      historyRow(
        1,
        Array.from({ length: 54 }, (_, i) => bucket(weekAt(i))),
      ),
    ]),
  }),
]);
const sellerNameKey = batch([product({ listings: observed("listings", [listing(1, { sellerName: "seller" })]) })]);
const labelEquals = batch([product({ sales: observed("sales", [sale({ condition: "Near=Mint" })]) })]);
const labelSemicolon = batch([product({ sales: observed("sales", [sale({ condition: "Near;Mint" })]) })]);
const dateOnlyRequestedAt = batch([product({ sales: observed("sales", [], { requestedAt: "2026-10-17" }) })]);
const dateOnlyOrderDate = batch([product({ sales: observed("sales", [sale({ orderDate: "2026-10-17" })]) })]);
const productIdMismatch = batch([product({ productId: 2 })]);
const productOrderMismatch = batch([product({ productId: 2 }), product({ productId: 1 })], twoProductRequest);
const productCountMismatch = batch([]);
const postureMismatch = batch([product()], request, { posture: { ...posture, timeoutMs: 999 } });
const whitespaceText = JSON.stringify(JSON.parse(batch()), null, 1);
const reorderedKeys = (() => {
  const value = JSON.parse(batch());
  return JSON.stringify({
    products: value.products,
    posture: value.posture,
    phase: value.phase,
    requestId: value.requestId,
    contractVersion: value.contractVersion,
  });
})();
const duplicatePricePointSku = batch(
  [{ productId: 1, pricePoints: [pricePoint(1), pricePoint(1)] }],
  pricePointsRequest,
);
const ordinalsOf = (ordinals: readonly number[]) =>
  batch([
    product({
      listings: observed(
        "listings",
        ordinals.map((o) => listing(o)),
      ),
    }),
  ]);
const duplicateHistorySku = batch([product({ history: observed("history", [historyRow(1), historyRow(1)]) })]);
const dateOf = (date: string) => batch([product({ history: observed("history", [historyRow(1, [bucket(date)])]) })]);
const duplicateBucketDates = batch([
  product({ history: observed("history", [historyRow(1, [bucket("2026-01-05"), bucket("2026-01-05")])]) }),
]);

const CANONICAL_GUARD_OFF: Replacement = [
  `if (JSON.stringify(out) !== text) bad("non_canonical_batch");`,
  `if (false) bad("non_canonical_batch");`,
];
const CAP_GUARD_OFF: Replacement = [
  `if (rows.length > cap) bad("invalid_endpoint_cap");`,
  `if (false) bad("invalid_endpoint_cap");`,
];
const HISTORY_DUPLICATE_GUARD_OFF: Replacement = [
  `if (k === "history" && new Set((parsed as HistoryRow[]).map((row) => row.skuId)).size !== parsed.length)\n    bad("invalid_history");`,
  `if (false) bad("invalid_history");`,
];
const PRICE_POINT_DUPLICATE_GUARD_OFF: Replacement = [
  `if (new Set(rows.map((y) => y.skuId)).size !== rows.length) bad("invalid_price_points");`,
  `if (false) bad("invalid_price_points");`,
];
// One bypass mutant per guard. The parser re-serializes its output and rejects any
// difference from the input, so a guard whose bypass changes the output (a dropped
// key, or a value restated from the request) needs that canonical guard off too,
// and a cap that the request's SKU count already implies needs the duplicate guard
// off too; each such entry says so in its name.
const b21: [
  name: string,
  replacements: Replacement[],
  text: string,
  req: TcgplayerMarketObservationRequest,
  expected: string,
][] = [
  [
    "B21 matrix: non-observed sales metadata field set",
    [
      [
        /if\s*\(\s*sales\.pagesFetched\s*!==\s*0\s*\|\|\s*sales\.returnedCount\s*!==\s*0\s*\|\|\s*sales\.firstReportedTotal\s*!==\s*null\s*\|\|\s*sales\.lastReportedTotal\s*!==\s*null\s*\|\|\s*sales\.firstResultCount\s*!==\s*null\s*\|\|\s*sales\.lastResultCount\s*!==\s*null\s*\|\|\s*sales\.lastNextPage\s*!==\s*null\s*\)\s*bad\("invalid_endpoint_matrix"\);/,
        `if (false) bad("invalid_endpoint_matrix");`,
      ],
    ],
    unavailableOffMatrix,
    request,
    "invalid_endpoint_matrix",
  ],
  [
    "B21 observed instants: response not before request",
    [["Date.parse(response) < Date.parse(requested)", "false"]],
    observedEarlierResponse,
    request,
    "invalid_endpoint_matrix",
  ],
  [
    "B21 disabled status",
    [[`!["observed", "unavailable", "not-requested"].includes(String(x.status)) ||`, ""]],
    disabledStatus,
    request,
    "invalid_endpoint",
  ],
  [
    "B21 unknown key: closed-key check (canonical guard also off: the output drops the key)",
    [[`Object.keys(r).some((k) => !keys.includes(k)) ||`, ""], CANONICAL_GUARD_OFF],
    saleUnknownKey,
    request,
    "invalid_sale",
  ],
  [
    "B21 cap: price points (duplicate-SKU guard also off: a third row must repeat a requested SKU)",
    [
      [`if (rows.length > p.skuIds.length) bad("invalid_price_points");`, `if (false) bad("invalid_price_points");`],
      PRICE_POINT_DUPLICATE_GUARD_OFF,
    ],
    pricePointsCapPlus,
    pricePointsRequest,
    "invalid_price_points",
  ],
  ["B21 cap: sales rows", [CAP_GUARD_OFF], salesCapPlus, request, "invalid_endpoint_cap"],
  ["B21 cap: listing rows", [CAP_GUARD_OFF], listingsCapPlus, request, "invalid_endpoint_cap"],
  [
    "B21 cap: history rows (duplicate-SKU guard also off: a 251st row must repeat a requested SKU)",
    [CAP_GUARD_OFF, HISTORY_DUPLICATE_GUARD_OFF],
    historyRowsCapPlus,
    wideRequest,
    "invalid_endpoint_cap",
  ],
  [
    "B21 cap: history buckets",
    [[`if (bs.length > HISTORY_BUCKET_CAP) bad("invalid_history");`, `if (false) bad("invalid_history");`]],
    bucketsCapPlus,
    request,
    "invalid_history",
  ],
  [
    "B21 listing identity key: sellerName admitted to the listing key list (canonical guard also off: the output drops the key)",
    [
      [
        `const LISTING_KEYS = ["sellerOrdinal", "condition", "printing", "language", "price", "sellerShippingPrice"] as const;`,
        `const LISTING_KEYS = ["sellerOrdinal", "condition", "printing", "language", "price", "sellerShippingPrice", "sellerName"] as const;`,
      ],
      CANONICAL_GUARD_OFF,
    ],
    sellerNameKey,
    request,
    "invalid_listing",
  ],
  [
    "B21 label grammar",
    [[`const LABEL = /^[A-Za-z0-9 ()'&,./+-]{1,64}$/;`, `const LABEL = /^[^]{1,64}$/;`]],
    labelEquals,
    request,
    "invalid_sale",
  ],
  [
    "B21 instant grammar",
    [
      [
        `typeof v !== "string" || !INSTANT.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v`,
        `typeof v !== "string"`,
      ],
    ],
    dateOnlyRequestedAt,
    request,
    "invalid_endpoint",
  ],
  [
    "B21 product equality (canonical guard also off: the output restates the request's product id)",
    [
      [`if (x.productId !== p.productId) bad("invalid_batch_product");`, `if (false) bad("invalid_batch_product");`],
      CANONICAL_GUARD_OFF,
    ],
    productIdMismatch,
    request,
    "invalid_batch_product",
  ],
  [
    "B21 posture equality (canonical guard also off: the output restates the request's posture)",
    [[`JSON.stringify(b.posture) !== JSON.stringify(r.posture)`, "false"], CANONICAL_GUARD_OFF],
    postureMismatch,
    request,
    "invalid_batch_request_mismatch",
  ],
  ["B21 canonical text check", [CANONICAL_GUARD_OFF], reorderedKeys, request, "non_canonical_batch"],
  [
    "B21 duplicate price-point SKU",
    [PRICE_POINT_DUPLICATE_GUARD_OFF],
    duplicatePricePointSku,
    pricePointsRequest,
    "invalid_price_points",
  ],
  [
    "B21 listing ordinal",
    [['bad("invalid_listing_ordinal")', "void 0"]],
    ordinalsOf([2]),
    request,
    "invalid_listing_ordinal",
  ],
  ["B21 duplicate history SKU", [HISTORY_DUPLICATE_GUARD_OFF], duplicateHistorySku, request, "invalid_history"],
  [
    "B21 calendar date",
    [["new Date(`${b.bucketStartDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== b.bucketStartDate", "false"]],
    dateOf("2026-02-30"),
    request,
    "invalid_history_bucket",
  ],
  [
    "B21 bucket-date order",
    [["buckets[i]!.bucketStartDate <= buckets[i - 1]!.bucketStartDate", "false"]],
    duplicateBucketDates,
    request,
    "invalid_history_bucket_dates",
  ],
];

describe("TCGplayer market observation batch (AC2)", () => {
  it("accepts the closed non-observed matrix", () =>
    expect(parseTcgplayerMarketObservationBatch(batch(), request).products).toHaveLength(1));
  it.each(b01)("%s is rejected with invalid_endpoint_matrix", (_name, status, kind, change) => {
    const block = status === "unavailable" ? endpoint(kind, change) : notRequested(kind, change);
    expect(codeOf(batch([product({ [kind]: block })]))).toBe("invalid_endpoint_matrix");
  });
  it("B01 accepts the closed not-requested matrix on every kind", () =>
    expect(
      parseTcgplayerMarketObservationBatch(
        batch([
          product({
            sales: notRequested("sales"),
            listings: notRequested("listings"),
            history: notRequested("history"),
          }),
        ]),
        request,
      ).products,
    ).toHaveLength(1));
  it("B02 observed with a null response instant is rejected", () =>
    expect(codeOf(observedNullResponse)).toBe("invalid_endpoint_matrix"));
  it("B03 observed with a response instant earlier than the request instant is rejected", () =>
    expect(codeOf(observedEarlierResponse)).toBe("invalid_endpoint_matrix"));
  it("B04 status disabled is rejected", () => expect(codeOf(disabledStatus)).toBe("invalid_endpoint"));
  it.each([
    ["B05 nested unknown key at the endpoint level", endpointUnknownKey, "invalid_endpoint"],
    ["B05 nested unknown key on a sale row", saleUnknownKey, "invalid_sale"],
    ["B05 nested unknown key on a listing row", listingUnknownKey, "invalid_listing"],
    ["B05 nested unknown key on a history row", historyUnknownKey, "invalid_history"],
    ["B05 nested unknown key on a history bucket", bucketUnknownKey, "invalid_history_bucket"],
  ])("%s is rejected", (_name, text, expected) => expect(codeOf(text)).toBe(expected));
  it.each([
    ["B06 price points at skuIds.length+1", pricePointsCapPlus, pricePointsRequest, "invalid_price_points"],
    [
      "B06 sales rows at min(salesLimit, salesPageSize×salesPageBudget)+1",
      salesCapPlus,
      request,
      "invalid_endpoint_cap",
    ],
    ["B06 listing rows at listingsPageSize×listingsPageBudget+1", listingsCapPlus, request, "invalid_endpoint_cap"],
    ["B06 history rows at 251", historyRowsCapPlus, wideRequest, "invalid_endpoint_cap"],
    ["B06 history buckets at 54", bucketsCapPlus, request, "invalid_history"],
  ])("%s is rejected", (_name, text, req, expected) => expect(codeOf(text, req)).toBe(expected));
  it("B06 accepts every cap exactly", () => {
    const atCap = batch(
      [
        product({
          sales: observed("sales", [sale(), sale()]),
          listings: observed(
            "listings",
            [1, 1, 1, 1, 1].map((o) => listing(o)),
          ),
          history: observed("history", [
            historyRow(
              1,
              Array.from({ length: 53 }, (_, i) => bucket(weekAt(i))),
            ),
          ]),
        }),
      ],
      request,
    );
    expect(codeOf(atCap)).toBe("accepted");
    const wideAtCap = batch(
      [
        product({
          history: observed(
            "history",
            skuIds250.map((skuId) => historyRow(skuId)),
          ),
        }),
      ],
      wideRequest,
    );
    expect(codeOf(wideAtCap, wideRequest)).toBe("accepted");
    const pricePointsAtCap = batch([{ productId: 1, pricePoints: [pricePoint(1), pricePoint(2)] }], pricePointsRequest);
    expect(codeOf(pricePointsAtCap, pricePointsRequest)).toBe("accepted");
  });
  it("B07 rejects a sellerName key on a listing row", () => expect(codeOf(sellerNameKey)).toBe("invalid_listing"));
  it("B08 rejects a label containing =", () => expect(codeOf(labelEquals)).toBe("invalid_sale"));
  it("B09 rejects a label containing ;", () => expect(codeOf(labelSemicolon)).toBe("invalid_sale"));
  it("B10 rejects a date-only value where an Instant is required", () => {
    expect(codeOf(dateOnlyRequestedAt)).toBe("invalid_endpoint");
    expect(codeOf(dateOnlyOrderDate)).toBe("invalid_sale");
  });
  it("B11 rejects a product id, order or count that differs from the request", () => {
    expect(codeOf(productIdMismatch)).toBe("invalid_batch_product");
    expect(codeOf(productOrderMismatch, twoProductRequest)).toBe("invalid_batch_product");
    expect(codeOf(productCountMismatch)).toBe("invalid_batch_products");
  });
  it("B12 rejects a posture that differs from the request", () =>
    expect(codeOf(postureMismatch)).toBe("invalid_batch_request_mismatch"));
  it("B13 rejects non-canonical text: inserted whitespace and reordered keys", () => {
    expect(codeOf(whitespaceText)).toBe("non_canonical_batch");
    expect(codeOf(reorderedKeys)).toBe("non_canonical_batch");
  });
  it("B14 rejects a duplicate price-point SKU", () =>
    expect(codeOf(duplicatePricePointSku, pricePointsRequest)).toBe("invalid_price_points"));
  it("B15 accepts dense first-seen ordinals and rejects a gap, a jump and a reversal", () => {
    expect(codeOf(ordinalsOf([1, 1, 2, 1, 3]))).toBe("accepted");
    for (const ordinals of [[2], [1, 3], [2, 1]]) expect(codeOf(ordinalsOf(ordinals))).toBe("invalid_listing_ordinal");
  });
  it("B16 rejects a duplicate history SKU", () => expect(codeOf(duplicateHistorySku)).toBe("invalid_history"));
  it("B17 rejects impossible calendar dates and accepts a real leap day", () => {
    for (const date of ["2026-02-30", "2026-04-31", "2025-02-29"])
      expect(codeOf(dateOf(date))).toBe("invalid_history_bucket");
    expect(codeOf(dateOf("2024-02-29"))).toBe("accepted");
  });
  it("B18 rejects duplicate bucket dates in one history row", () =>
    expect(codeOf(duplicateBucketDates)).toBe("invalid_history_bucket_dates"));
  it("B19 the canonical writer rebuilds grammar order at every depth: secondary rows and buckets, and price points", () => {
    const secondaryText = batch([
      product({
        sales: observed("sales", [sale(), sale({ quantity: 2 })]),
        listings: observed("listings", [listing(1), listing(1), listing(2)]),
        history: observed("history", [
          historyRow(1, [bucket("2026-01-05"), bucket("2026-01-12", { marketPrice: "2.50" })]),
          historyRow(2, [bucket("2026-01-05")]),
        ]),
      }),
    ]);
    const parsed = parseTcgplayerMarketObservationBatch(secondaryText, request);
    expect(canonicalizeTcgplayerMarketObservationBatch(parsed)).toBe(secondaryText);
    const reversed = reverseKeys(JSON.parse(secondaryText)) as TcgplayerMarketObservationBatch;
    expect(JSON.stringify(reversed)).not.toBe(secondaryText);
    expect(codeOf(JSON.stringify(reversed))).not.toBe("accepted");
    const written = canonicalizeTcgplayerMarketObservationBatch(reversed);
    expect(written).toBe(secondaryText);
    expect(codeOf(written)).toBe("accepted");
    const priceText = batch(
      [{ productId: 1, pricePoints: [pricePoint(1), pricePoint(2, { marketPrice: "1.00" })] }],
      pricePointsRequest,
    );
    const priceWritten = canonicalizeTcgplayerMarketObservationBatch(
      reverseKeys(JSON.parse(priceText)) as TcgplayerMarketObservationBatch,
    );
    expect(priceWritten).toBe(priceText);
    expect(codeOf(priceWritten, pricePointsRequest)).toBe("accepted");
  });
  it("B20 the canonical writer rejects non-grammar input with invalid_batch instead of passing it through", () =>
    expect(errorCode(() => canonicalizeTcgplayerMarketObservationBatch({ anything: "é" } as never))).toBe(
      "invalid_batch",
    ));
  it.each(b21)(
    "%s: the real parser rejects and the bypass mutant accepts",
    (_name, replacements, text, req, expected) => {
      expect(codeOf(text, req)).toBe(expected);
      const mutant = sourceMutant<typeof parseTcgplayerMarketObservationBatch>(
        replacements,
        "parseTcgplayerMarketObservationBatch",
      );
      expect(errorCode(() => mutant(text, req))).toBe("accepted");
    },
  );
  it("B21 canonical writer mutant: a pass-through writer's output is rejected as non-canonical", () => {
    const canonicalMutant = sourceMutant<(value: unknown) => string>(
      [
        [
          `return JSON.stringify({ contractVersion: 1, requestId: value.requestId, phase: value.phase, posture, products });`,
          "return JSON.stringify(value);",
        ],
      ],
      "canonicalizeTcgplayerMarketObservationBatch",
    );
    const reversed = JSON.parse(reorderedKeys);
    expect(codeOf(canonicalMutant(reversed))).toBe("non_canonical_batch");
    expect(codeOf(canonicalizeTcgplayerMarketObservationBatch(reversed as TcgplayerMarketObservationBatch))).toBe(
      "accepted",
    );
  });
});
