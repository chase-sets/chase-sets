const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LABEL = /^[A-Za-z0-9 ()'&,./+-]{1,64}$/;
const MONEY = /^\d{1,7}\.\d{2}$/;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export const PART_TEXT_MAX_BYTES = 30000;
export type TcgplayerMarketObservationPhase = "price-points" | "secondary";
export type EndpointStatus = "observed" | "unavailable" | "not-requested";
export type HttpStatusClass = "none" | "4xx" | "5xx" | "other";
export type CredentialsMode = "omit" | "include";
export type TcgplayerMarketObservationPosture = Readonly<{
  salesOffset: 0;
  salesLimit: number;
  salesPageSize: number;
  salesPageBudget: number;
  salesConditions: readonly number[];
  salesLanguages: readonly number[];
  salesVariants: readonly number[];
  salesListingType: "ListingWithoutPhotos" | "ListingWithPhotos" | "All";
  listingsVerifiedOnly: boolean;
  listingsPageSize: number;
  listingsPageBudget: number;
  listingsDeliveredCeiling: string;
  historyRange: "annual";
  timeoutMs: number;
}>;
export type TcgplayerMarketObservationRequestProduct = Readonly<{
  productId: number;
  skuIds: readonly number[];
  skuTargetCount: number;
}>;
export type TcgplayerMarketObservationRequest = Readonly<{
  contractVersion: 1;
  requestId: string;
  phase: TcgplayerMarketObservationPhase;
  issuedAt: string;
  products: readonly TcgplayerMarketObservationRequestProduct[];
  posture: TcgplayerMarketObservationPosture | null;
}>;
export type PricePoint = Readonly<{
  skuId: number;
  marketPrice: string | null;
  lowestPrice: string | null;
  highestPrice: string | null;
  priceCount: number | null;
  calculatedAt: string | null;
}>;
export type Sale = Readonly<{
  condition: string;
  variant: string;
  language: string;
  listingType: string;
  quantity: number;
  purchasePrice: string;
  shippingPrice: string;
  orderDate: string;
}>;
export type Listing = Readonly<{
  sellerOrdinal: number;
  condition: string;
  printing: string;
  language: string;
  price: string;
  sellerShippingPrice: string;
}>;
export type HistoryBucket = Readonly<{
  bucketStartDate: string;
  marketPrice: string | null;
  quantitySold: number;
  transactionCount: number;
  lowSalePrice: string | null;
  lowSalePriceWithShipping: string | null;
  highSalePrice: string | null;
  highSalePriceWithShipping: string | null;
}>;
export type HistoryRow = Readonly<{
  skuId: number;
  variant: string;
  language: string;
  condition: string;
  buckets: readonly HistoryBucket[];
}>;
export type SalesMetadata = Readonly<{
  coverage: "complete" | "request-cap-truncated" | "page-budget-truncated" | "inconsistent" | "unknown";
  pagesFetched: number;
  returnedCount: number;
  firstReportedTotal: number | null;
  lastReportedTotal: number | null;
  firstResultCount: number | null;
  lastResultCount: number | null;
  lastNextPage: "Yes" | "" | null;
}>;
export type ListingsMetadata = Readonly<{
  coverage: "complete" | "ceiling-truncated" | "page-budget-truncated" | "inconsistent" | "unknown";
  pagesFetched: number;
  returnedCount: number;
  reportedTotal: number | null;
}>;
export type HistoryMetadata = Readonly<{
  coverage: "observed" | "inconsistent" | "unknown";
  resultCount: number;
  bucketCount: number;
}>;
export type Endpoint<T, M> = Readonly<{
  status: EndpointStatus;
  httpStatusClass: HttpStatusClass;
  credentialsMode: CredentialsMode | null;
  requestedAt: string | null;
  responseObservedAt: string | null;
  rejectedRows: number;
  rows: readonly T[];
}> &
  M;
export type PricePointsProduct = Readonly<{ productId: number; pricePoints: readonly PricePoint[] }>;
export type SecondaryProduct = Readonly<{
  productId: number;
  sales: Endpoint<Sale, SalesMetadata>;
  listings: Endpoint<Listing, ListingsMetadata>;
  history: Endpoint<HistoryRow, HistoryMetadata>;
}>;
export type TcgplayerMarketObservationBatch = Readonly<{
  contractVersion: 1;
  requestId: string;
  phase: TcgplayerMarketObservationPhase;
  posture: TcgplayerMarketObservationPosture | null;
  products: readonly (PricePointsProduct | SecondaryProduct)[];
}>;
export type TcgplayerMarketObservationPartPayload = Readonly<{
  batchId: string;
  requestId: string;
  phase: TcgplayerMarketObservationPhase;
  partIndex: number;
  text: string;
}>;
export type TcgplayerMarketObservationAdmissionPayload = Readonly<{
  batchId: string;
  requestId: string;
  phase: TcgplayerMarketObservationPhase;
  contractVersion: 1;
  partCount: number;
  textBytes: number;
  digest: string;
  grantId: string;
  creatorMembershipId: string;
  creatorUserId: string;
  admittedAt: string;
}>;
export type TcgplayerMarketObservationHistoryEvent = Readonly<{ streamVersion: number; data: unknown }>;
export type TcgplayerMarketObservationRequestSource = Readonly<{
  currentRequest(): Promise<TcgplayerMarketObservationRequest | null>;
}>;
export class TcgplayerMarketObservationContractError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "TcgplayerMarketObservationContractError";
    this.code = code;
  }
}
const bad = (code: string): never => {
  throw new TcgplayerMarketObservationContractError(code);
};
function rec(v: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(code);
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(r, k))) bad(code);
  return r;
}
function arr(v: unknown, code: string): unknown[] {
  if (!Array.isArray(v)) bad(code);
  return v as unknown[];
}
function integer(v: unknown, min: number, max: number, code: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) bad(code);
  return v as number;
}
function instant(v: unknown, code: string): string {
  if (typeof v !== "string" || !INSTANT.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)
    bad(code);
  return v as string;
}
function money(v: unknown, code: string): string {
  if (typeof v !== "string" || !MONEY.test(v)) bad(code);
  return v as string;
}
function label(v: unknown, code: string): string {
  if (typeof v !== "string" || !LABEL.test(v)) bad(code);
  return v as string;
}
function ascending(a: readonly number[], code: string) {
  for (let i = 1; i < a.length; i++) if (a[i]! <= a[i - 1]!) bad(code);
}
const POSTURE_KEYS = [
  "salesOffset",
  "salesLimit",
  "salesPageSize",
  "salesPageBudget",
  "salesConditions",
  "salesLanguages",
  "salesVariants",
  "salesListingType",
  "listingsVerifiedOnly",
  "listingsPageSize",
  "listingsPageBudget",
  "listingsDeliveredCeiling",
  "historyRange",
  "timeoutMs",
] as const;
function parsePosture(v: unknown): TcgplayerMarketObservationPosture {
  const p = rec(v, POSTURE_KEYS, "invalid_posture");
  const ints = (x: unknown) => {
    const a = arr(x, "invalid_posture").map((n) => integer(n, 0, Number.MAX_SAFE_INTEGER, "invalid_posture"));
    ascending(a, "invalid_posture");
    return a;
  };
  if (
    p.salesOffset !== 0 ||
    (p.salesListingType !== "ListingWithoutPhotos" &&
      p.salesListingType !== "ListingWithPhotos" &&
      p.salesListingType !== "All") ||
    typeof p.listingsVerifiedOnly !== "boolean" ||
    p.historyRange !== "annual"
  )
    bad("invalid_posture");
  return {
    salesOffset: 0,
    salesLimit: integer(p.salesLimit, 1, 10000, "invalid_posture"),
    salesPageSize: integer(p.salesPageSize, 1, 250, "invalid_posture"),
    salesPageBudget: integer(p.salesPageBudget, 1, 100, "invalid_posture"),
    salesConditions: ints(p.salesConditions),
    salesLanguages: ints(p.salesLanguages),
    salesVariants: ints(p.salesVariants),
    salesListingType: p.salesListingType as TcgplayerMarketObservationPosture["salesListingType"],
    listingsVerifiedOnly: p.listingsVerifiedOnly as boolean,
    listingsPageSize: integer(p.listingsPageSize, 1, 250, "invalid_posture"),
    listingsPageBudget: integer(p.listingsPageBudget, 1, 100, "invalid_posture"),
    listingsDeliveredCeiling: money(p.listingsDeliveredCeiling, "invalid_posture"),
    historyRange: "annual",
    timeoutMs: integer(p.timeoutMs, 1, 120000, "invalid_posture"),
  };
}
export function parseTcgplayerMarketObservationRequest(v: unknown): TcgplayerMarketObservationRequest {
  const r = rec(v, ["contractVersion", "requestId", "phase", "issuedAt", "products", "posture"], "invalid_request");
  if (
    r.contractVersion !== 1 ||
    typeof r.requestId !== "string" ||
    !UUID.test(r.requestId) ||
    (r.phase !== "price-points" && r.phase !== "secondary")
  )
    bad("invalid_request");
  const ps = arr(r.products, "invalid_request");
  if (ps.length < 1 || ps.length > 5) bad("invalid_request_product_count");
  const products = ps.map((x) => {
    const p = rec(x, ["productId", "skuIds", "skuTargetCount"], "invalid_request_product");
    const ids = arr(p.skuIds, "invalid_request_sku").map((n) =>
      integer(n, 1, Number.MAX_SAFE_INTEGER, "invalid_request_sku"),
    );
    if (ids.length < 1 || ids.length > 250) bad("invalid_request_sku_count");
    ascending(ids, "invalid_request_skus");
    return {
      productId: integer(p.productId, 1, 2147483647, "invalid_request_product_id"),
      skuIds: ids,
      skuTargetCount: integer(p.skuTargetCount, ids.length, Number.MAX_SAFE_INTEGER, "invalid_request_target"),
    };
  });
  ascending(
    products.map((p) => p.productId),
    "invalid_request_product_ids",
  );
  const posture = r.posture === null ? null : parsePosture(r.posture);
  if ((r.phase === "price-points") !== (posture === null)) bad("invalid_request_posture_presence");
  return {
    contractVersion: 1,
    requestId: r.requestId as string,
    phase: r.phase as TcgplayerMarketObservationPhase,
    issuedAt: instant(r.issuedAt, "invalid_request_issued_at"),
    products,
    posture,
  };
}
const nullableMoney = (v: unknown, c: string) => (v === null ? null : money(v, c));
function parsePrice(v: unknown, p: TcgplayerMarketObservationRequestProduct): PricePoint {
  const x = rec(
    v,
    ["skuId", "marketPrice", "lowestPrice", "highestPrice", "priceCount", "calculatedAt"],
    "invalid_price_point",
  );
  const skuId = integer(x.skuId, 1, Number.MAX_SAFE_INTEGER, "invalid_price_point");
  if (!p.skuIds.includes(skuId)) bad("invalid_price_point");
  return {
    skuId,
    marketPrice: nullableMoney(x.marketPrice, "invalid_price_point"),
    lowestPrice: nullableMoney(x.lowestPrice, "invalid_price_point"),
    highestPrice: nullableMoney(x.highestPrice, "invalid_price_point"),
    priceCount: x.priceCount === null ? null : integer(x.priceCount, 0, Number.MAX_SAFE_INTEGER, "invalid_price_point"),
    calculatedAt: x.calculatedAt === null ? null : instant(x.calculatedAt, "invalid_price_point"),
  };
}
function parseSale(v: unknown): Sale {
  const x = rec(
    v,
    ["condition", "variant", "language", "listingType", "quantity", "purchasePrice", "shippingPrice", "orderDate"],
    "invalid_sale",
  );
  return {
    condition: label(x.condition, "invalid_sale"),
    variant: label(x.variant, "invalid_sale"),
    language: label(x.language, "invalid_sale"),
    listingType: label(x.listingType, "invalid_sale"),
    quantity: integer(x.quantity, 0, Number.MAX_SAFE_INTEGER, "invalid_sale"),
    purchasePrice: money(x.purchasePrice, "invalid_sale"),
    shippingPrice: money(x.shippingPrice, "invalid_sale"),
    orderDate: instant(x.orderDate, "invalid_sale"),
  };
}
function parseListing(v: unknown): Listing {
  const x = rec(
    v,
    ["sellerOrdinal", "condition", "printing", "language", "price", "sellerShippingPrice"],
    "invalid_listing",
  );
  return {
    sellerOrdinal: integer(x.sellerOrdinal, 1, Number.MAX_SAFE_INTEGER, "invalid_listing"),
    condition: label(x.condition, "invalid_listing"),
    printing: label(x.printing, "invalid_listing"),
    language: label(x.language, "invalid_listing"),
    price: money(x.price, "invalid_listing"),
    sellerShippingPrice: money(x.sellerShippingPrice, "invalid_listing"),
  };
}
function parseHistory(v: unknown, p: TcgplayerMarketObservationRequestProduct): HistoryRow {
  const x = rec(v, ["skuId", "variant", "language", "condition", "buckets"], "invalid_history");
  const skuId = integer(x.skuId, 1, Number.MAX_SAFE_INTEGER, "invalid_history");
  if (!p.skuIds.includes(skuId)) bad("invalid_history");
  const bs = arr(x.buckets, "invalid_history");
  if (bs.length > 53) bad("invalid_history");
  const buckets = bs.map((y) => {
    const b = rec(
      y,
      [
        "bucketStartDate",
        "marketPrice",
        "quantitySold",
        "transactionCount",
        "lowSalePrice",
        "lowSalePriceWithShipping",
        "highSalePrice",
        "highSalePriceWithShipping",
      ],
      "invalid_history_bucket",
    );
    if (
      typeof b.bucketStartDate !== "string" ||
      !/^\d{4}-\d\d-\d\d$/.test(b.bucketStartDate) ||
      !Number.isFinite(Date.parse(`${b.bucketStartDate}T00:00:00.000Z`)) ||
      new Date(`${b.bucketStartDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== b.bucketStartDate
    )
      bad("invalid_history_bucket");
    return {
      bucketStartDate: b.bucketStartDate as string,
      marketPrice: nullableMoney(b.marketPrice, "invalid_history_bucket"),
      quantitySold: integer(b.quantitySold, 0, Number.MAX_SAFE_INTEGER, "invalid_history_bucket"),
      transactionCount: integer(b.transactionCount, 1, Number.MAX_SAFE_INTEGER, "invalid_history_bucket"),
      lowSalePrice: nullableMoney(b.lowSalePrice, "invalid_history_bucket"),
      lowSalePriceWithShipping: nullableMoney(b.lowSalePriceWithShipping, "invalid_history_bucket"),
      highSalePrice: nullableMoney(b.highSalePrice, "invalid_history_bucket"),
      highSalePriceWithShipping: nullableMoney(b.highSalePriceWithShipping, "invalid_history_bucket"),
    };
  });
  for (let i = 1; i < buckets.length; i++)
    if (buckets[i]!.bucketStartDate <= buckets[i - 1]!.bucketStartDate) bad("invalid_history_bucket_dates");
  return {
    skuId,
    variant: label(x.variant, "invalid_history"),
    language: label(x.language, "invalid_history"),
    condition: label(x.condition, "invalid_history"),
    buckets,
  };
}
function metadata(v: unknown, k: "sales" | "listings" | "history", p: TcgplayerMarketObservationPosture) {
  if (k === "sales") {
    const x = rec(
      v,
      [
        "coverage",
        "pagesFetched",
        "returnedCount",
        "firstReportedTotal",
        "lastReportedTotal",
        "firstResultCount",
        "lastResultCount",
        "lastNextPage",
      ],
      "invalid_sales_metadata",
    );
    if (
      !["complete", "request-cap-truncated", "page-budget-truncated", "inconsistent", "unknown"].includes(
        String(x.coverage),
      )
    )
      bad("invalid_sales_metadata");
    return {
      coverage: x.coverage as SalesMetadata["coverage"],
      pagesFetched: integer(x.pagesFetched, 0, p.salesPageBudget, "invalid_sales_metadata"),
      returnedCount: integer(
        x.returnedCount,
        0,
        Math.min(p.salesLimit, p.salesPageSize * p.salesPageBudget),
        "invalid_sales_metadata",
      ),
      firstReportedTotal:
        x.firstReportedTotal === null
          ? null
          : integer(x.firstReportedTotal, 0, Number.MAX_SAFE_INTEGER, "invalid_sales_metadata"),
      lastReportedTotal:
        x.lastReportedTotal === null
          ? null
          : integer(x.lastReportedTotal, 0, Number.MAX_SAFE_INTEGER, "invalid_sales_metadata"),
      firstResultCount:
        x.firstResultCount === null
          ? null
          : integer(x.firstResultCount, 0, Number.MAX_SAFE_INTEGER, "invalid_sales_metadata"),
      lastResultCount:
        x.lastResultCount === null
          ? null
          : integer(x.lastResultCount, 0, Number.MAX_SAFE_INTEGER, "invalid_sales_metadata"),
      lastNextPage:
        x.lastNextPage === null
          ? null
          : x.lastNextPage === "Yes" || x.lastNextPage === ""
            ? x.lastNextPage
            : bad("invalid_sales_metadata"),
    };
  }
  if (k === "listings") {
    const x = rec(v, ["coverage", "pagesFetched", "returnedCount", "reportedTotal"], "invalid_listings_metadata");
    if (
      !["complete", "ceiling-truncated", "page-budget-truncated", "inconsistent", "unknown"].includes(
        String(x.coverage),
      )
    )
      bad("invalid_listings_metadata");
    return {
      coverage: x.coverage as ListingsMetadata["coverage"],
      pagesFetched: integer(x.pagesFetched, 0, p.listingsPageBudget, "invalid_listings_metadata"),
      returnedCount: integer(
        x.returnedCount,
        0,
        p.listingsPageSize * p.listingsPageBudget,
        "invalid_listings_metadata",
      ),
      reportedTotal:
        x.reportedTotal === null
          ? null
          : integer(x.reportedTotal, 0, Number.MAX_SAFE_INTEGER, "invalid_listings_metadata"),
    };
  }
  const x = rec(v, ["coverage", "resultCount", "bucketCount"], "invalid_history_metadata");
  if (!["observed", "inconsistent", "unknown"].includes(String(x.coverage))) bad("invalid_history_metadata");
  return {
    coverage: x.coverage as HistoryMetadata["coverage"],
    resultCount: integer(x.resultCount, 0, 250, "invalid_history_metadata"),
    bucketCount: integer(x.bucketCount, 0, 13250, "invalid_history_metadata"),
  };
}
function endpoint(
  v: unknown,
  k: "sales" | "listings" | "history",
  p: TcgplayerMarketObservationRequestProduct,
  r: TcgplayerMarketObservationRequest,
) {
  const keys =
    k === "sales"
      ? [
          "coverage",
          "pagesFetched",
          "returnedCount",
          "firstReportedTotal",
          "lastReportedTotal",
          "firstResultCount",
          "lastResultCount",
          "lastNextPage",
        ]
      : k === "listings"
        ? ["coverage", "pagesFetched", "returnedCount", "reportedTotal"]
        : ["coverage", "resultCount", "bucketCount"];
  const x = rec(
    v,
    [
      "status",
      "httpStatusClass",
      "credentialsMode",
      "requestedAt",
      "responseObservedAt",
      "rejectedRows",
      "rows",
      ...keys,
    ],
    "invalid_endpoint",
  );
  if (
    !["observed", "unavailable", "not-requested"].includes(String(x.status)) ||
    !["none", "4xx", "5xx", "other"].includes(String(x.httpStatusClass))
  )
    bad("invalid_endpoint");
  const status = x.status as EndpointStatus;
  const mode =
    x.credentialsMode === null
      ? null
      : x.credentialsMode === "omit" || x.credentialsMode === "include"
        ? x.credentialsMode
        : bad("invalid_endpoint");
  const requested = x.requestedAt === null ? null : instant(x.requestedAt, "invalid_endpoint");
  const response = x.responseObservedAt === null ? null : instant(x.responseObservedAt, "invalid_endpoint");
  if (
    status === "observed"
      ? x.httpStatusClass !== "none" ||
        mode === null ||
        requested === null ||
        response === null ||
        Date.parse(response) < Date.parse(requested)
      : status === "unavailable"
        ? mode === null || requested === null || response !== null || x.httpStatusClass === "none"
        : mode !== null || requested !== null || response !== null || x.httpStatusClass !== "none"
  )
    bad("invalid_endpoint_matrix");
  const rows = arr(x.rows, "invalid_endpoint");
  const parsed =
    k === "sales"
      ? rows.map(parseSale)
      : k === "listings"
        ? rows.map(parseListing)
        : rows.map((y) => parseHistory(y, p));
  if (k === "listings") {
    let maxSeen = 0;
    for (const row of parsed as Listing[]) {
      if (row.sellerOrdinal > maxSeen + 1) bad("invalid_listing_ordinal");
      if (row.sellerOrdinal === maxSeen + 1) maxSeen = row.sellerOrdinal;
    }
  }
  if (k === "history" && new Set((parsed as HistoryRow[]).map((row) => row.skuId)).size !== parsed.length)
    bad("invalid_history");
  const m = metadata(Object.fromEntries(keys.map((key) => [key, x[key]])), k, r.posture!);
  const cap =
    k === "sales"
      ? Math.min(r.posture!.salesLimit, r.posture!.salesPageSize * r.posture!.salesPageBudget)
      : k === "listings"
        ? r.posture!.listingsPageSize * r.posture!.listingsPageBudget
        : 250;
  if (parsed.length > cap || integer(x.rejectedRows, 0, cap, "invalid_endpoint") > cap) bad("invalid_endpoint_cap");
  if (status !== "observed") {
    const rejectedRows = integer(x.rejectedRows, 0, cap, "invalid_endpoint");
    if (rejectedRows !== 0 || parsed.length !== 0 || (m as { coverage: string }).coverage !== "unknown")
      bad("invalid_endpoint_matrix");
    if (k === "sales") {
      const sales = m as SalesMetadata;
      if (
        sales.pagesFetched !== 0 ||
        sales.returnedCount !== 0 ||
        sales.firstReportedTotal !== null ||
        sales.lastReportedTotal !== null ||
        sales.firstResultCount !== null ||
        sales.lastResultCount !== null ||
        sales.lastNextPage !== null
      )
        bad("invalid_endpoint_matrix");
    } else if (k === "listings") {
      const listings = m as ListingsMetadata;
      if (listings.pagesFetched !== 0 || listings.returnedCount !== 0 || listings.reportedTotal !== null)
        bad("invalid_endpoint_matrix");
    } else {
      const history = m as HistoryMetadata;
      if (history.resultCount !== 0 || history.bucketCount !== 0) bad("invalid_endpoint_matrix");
    }
  }
  return {
    status,
    httpStatusClass: x.httpStatusClass as HttpStatusClass,
    credentialsMode: mode,
    requestedAt: requested,
    responseObservedAt: response,
    rejectedRows: x.rejectedRows as number,
    rows: parsed,
    ...m,
  };
}
export function parseTcgplayerMarketObservationBatch(
  text: string,
  requestInput: TcgplayerMarketObservationRequest,
): TcgplayerMarketObservationBatch {
  const r = parseTcgplayerMarketObservationRequest(requestInput);
  if (typeof text !== "string") bad("invalid_batch_text");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad("invalid_batch_json");
  }
  const b = rec(raw, ["contractVersion", "requestId", "phase", "posture", "products"], "invalid_batch");
  if (
    b.contractVersion !== 1 ||
    b.requestId !== r.requestId ||
    b.phase !== r.phase ||
    JSON.stringify(b.posture) !== JSON.stringify(r.posture)
  )
    bad("invalid_batch_request_mismatch");
  const ps = arr(b.products, "invalid_batch_products");
  if (ps.length !== r.products.length) bad("invalid_batch_products");
  const products = ps.map((v, i) => {
    const p = r.products[i]!;
    if (r.phase === "price-points") {
      const x = rec(v, ["productId", "pricePoints"], "invalid_batch_product");
      if (x.productId !== p.productId) bad("invalid_batch_product");
      const rows = arr(x.pricePoints, "invalid_price_points").map((y) => parsePrice(y, p));
      if (rows.length > p.skuIds.length || new Set(rows.map((y) => y.skuId)).size !== rows.length)
        bad("invalid_price_points");
      return { productId: p.productId, pricePoints: rows };
    }
    const x = rec(v, ["productId", "sales", "listings", "history"], "invalid_batch_product");
    if (x.productId !== p.productId) bad("invalid_batch_product");
    return {
      productId: p.productId,
      sales: endpoint(x.sales, "sales", p, r),
      listings: endpoint(x.listings, "listings", p, r),
      history: endpoint(x.history, "history", p, r),
    };
  });
  const out = { contractVersion: 1 as const, requestId: r.requestId, phase: r.phase, posture: r.posture, products };
  if (JSON.stringify(out) !== text) bad("non_canonical_batch");
  return out as TcgplayerMarketObservationBatch;
}
export function canonicalizeTcgplayerMarketObservationBatch(value: TcgplayerMarketObservationBatch): string {
  const candidate = value as unknown as Record<string, unknown>;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.phase !== "string" ||
    !Array.isArray(candidate.products)
  )
    return JSON.stringify(value);
  const posture =
    value.posture === null
      ? null
      : {
          salesOffset: value.posture.salesOffset,
          salesLimit: value.posture.salesLimit,
          salesPageSize: value.posture.salesPageSize,
          salesPageBudget: value.posture.salesPageBudget,
          salesConditions: value.posture.salesConditions,
          salesLanguages: value.posture.salesLanguages,
          salesVariants: value.posture.salesVariants,
          salesListingType: value.posture.salesListingType,
          listingsVerifiedOnly: value.posture.listingsVerifiedOnly,
          listingsPageSize: value.posture.listingsPageSize,
          listingsPageBudget: value.posture.listingsPageBudget,
          listingsDeliveredCeiling: value.posture.listingsDeliveredCeiling,
          historyRange: value.posture.historyRange,
          timeoutMs: value.posture.timeoutMs,
        };
  const products = value.products.map((product) => {
    if (value.phase === "price-points") {
      const priceProduct = product as PricePointsProduct;
      return {
        productId: priceProduct.productId,
        pricePoints: priceProduct.pricePoints.map((row) => ({
          skuId: row.skuId,
          marketPrice: row.marketPrice,
          lowestPrice: row.lowestPrice,
          highestPrice: row.highestPrice,
          priceCount: row.priceCount,
          calculatedAt: row.calculatedAt,
        })),
      };
    }
    const secondary = product as SecondaryProduct;
    const writeEndpoint = (endpointValue: Endpoint<unknown, object>, kind: "sales" | "listings" | "history") => {
      const metadataKeys =
        kind === "sales"
          ? [
              "coverage",
              "pagesFetched",
              "returnedCount",
              "firstReportedTotal",
              "lastReportedTotal",
              "firstResultCount",
              "lastResultCount",
              "lastNextPage",
            ]
          : kind === "listings"
            ? ["coverage", "pagesFetched", "returnedCount", "reportedTotal"]
            : ["coverage", "resultCount", "bucketCount"];
      const out: Record<string, unknown> = {
        status: endpointValue.status,
        httpStatusClass: endpointValue.httpStatusClass,
        credentialsMode: endpointValue.credentialsMode,
        requestedAt: endpointValue.requestedAt,
        responseObservedAt: endpointValue.responseObservedAt,
        rejectedRows: endpointValue.rejectedRows,
        rows: endpointValue.rows,
      };
      for (const key of metadataKeys) out[key] = (endpointValue as Record<string, unknown>)[key];
      return out;
    };
    return {
      productId: secondary.productId,
      sales: writeEndpoint(secondary.sales as Endpoint<unknown, object>, "sales"),
      listings: writeEndpoint(secondary.listings as Endpoint<unknown, object>, "listings"),
      history: writeEndpoint(secondary.history as Endpoint<unknown, object>, "history"),
    };
  });
  return JSON.stringify({ contractVersion: 1, requestId: value.requestId, phase: value.phase, posture, products });
}
export async function digestTcgplayerMarketObservationBatchText(text: string): Promise<string> {
  if (typeof text !== "string" || !/^\x00*[\x00-\x7F]*$/.test(text)) bad("invalid_batch_text");
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function splitTcgplayerMarketObservationBatchText(text: string): readonly string[] {
  if (typeof text !== "string" || !/^[\x00-\x7F]*$/.test(text) || text.length === 0) bad("invalid_batch_text");
  const bytes = new TextEncoder().encode(text),
    parts: string[] = [];
  for (let i = 0; i < bytes.length; i += PART_TEXT_MAX_BYTES)
    parts.push(new TextDecoder().decode(bytes.slice(i, i + PART_TEXT_MAX_BYTES)));
  return parts;
}
export function maxBatchTextBytes(request: TcgplayerMarketObservationRequest): number {
  const maxLabel = "A".repeat(64);
  const maxMoney = "9999999.99";
  const maxInstant = "9999-12-31T23:59:59.999Z";
  const maxSkuId = Math.max(...request.products.flatMap((product) => product.skuIds));
  const maxProduct = Math.max(...request.products.map((product) => product.productId));
  const maximalPricePoint = (skuId: number) => ({
    skuId,
    marketPrice: maxMoney,
    lowestPrice: maxMoney,
    highestPrice: maxMoney,
    priceCount: Number.MAX_SAFE_INTEGER,
    calculatedAt: maxInstant,
  });
  const maximalSale = () => ({
    condition: maxLabel,
    variant: maxLabel,
    language: maxLabel,
    listingType: maxLabel,
    quantity: Number.MAX_SAFE_INTEGER,
    purchasePrice: maxMoney,
    shippingPrice: maxMoney,
    orderDate: maxInstant,
  });
  const maximalListing = (sellerOrdinal: number) => ({
    sellerOrdinal,
    condition: maxLabel,
    printing: maxLabel,
    language: maxLabel,
    price: maxMoney,
    sellerShippingPrice: maxMoney,
  });
  const maximalHistory = () => ({
    skuId: maxSkuId,
    variant: maxLabel,
    language: maxLabel,
    condition: maxLabel,
    buckets: Array.from({ length: 53 }, (_, index) => {
      const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
      return {
        bucketStartDate: date,
        marketPrice: maxMoney,
        quantitySold: Number.MAX_SAFE_INTEGER,
        transactionCount: Number.MAX_SAFE_INTEGER,
        lowSalePrice: maxMoney,
        lowSalePriceWithShipping: maxMoney,
        highSalePrice: maxMoney,
        highSalePriceWithShipping: maxMoney,
      };
    }),
  });
  const maximalEndpoint = (kind: "sales" | "listings" | "history", cap: number) => {
    if (kind === "sales")
      return {
        status: "observed" as const,
        httpStatusClass: "none" as const,
        credentialsMode: "include" as const,
        requestedAt: maxInstant,
        responseObservedAt: maxInstant,
        rejectedRows: cap,
        rows: Array.from({ length: cap }, maximalSale),
        coverage: "request-cap-truncated" as const,
        pagesFetched: 100,
        returnedCount: cap,
        firstReportedTotal: Number.MAX_SAFE_INTEGER,
        lastReportedTotal: Number.MAX_SAFE_INTEGER,
        firstResultCount: Number.MAX_SAFE_INTEGER,
        lastResultCount: Number.MAX_SAFE_INTEGER,
        lastNextPage: "Yes" as const,
      };
    if (kind === "listings")
      return {
        status: "observed" as const,
        httpStatusClass: "none" as const,
        credentialsMode: "include" as const,
        requestedAt: maxInstant,
        responseObservedAt: maxInstant,
        rejectedRows: cap,
        rows: Array.from({ length: cap }, (_, index) => maximalListing(index + 1)),
        coverage: "page-budget-truncated" as const,
        pagesFetched: 100,
        returnedCount: cap,
        reportedTotal: Number.MAX_SAFE_INTEGER,
      };
    return {
      status: "observed" as const,
      httpStatusClass: "none" as const,
      credentialsMode: "include" as const,
      requestedAt: maxInstant,
      responseObservedAt: maxInstant,
      rejectedRows: 250,
      rows: Array.from({ length: 250 }, maximalHistory),
      coverage: "inconsistent" as const,
      resultCount: 250,
      bucketCount: 13250,
    };
  };
  const products = request.products.map((product) => {
    if (request.phase === "price-points")
      return { productId: product.productId, pricePoints: product.skuIds.map((skuId) => maximalPricePoint(skuId)) };
    const salesCap = Math.min(
      request.posture!.salesLimit,
      request.posture!.salesPageSize * request.posture!.salesPageBudget,
    );
    const listingsCap = request.posture!.listingsPageSize * request.posture!.listingsPageBudget;
    return {
      productId: product.productId,
      sales: maximalEndpoint("sales", salesCap),
      listings: maximalEndpoint("listings", listingsCap),
      history: maximalEndpoint("history", 250),
    };
  });
  return new TextEncoder().encode(
    JSON.stringify({
      contractVersion: 1,
      requestId: request.requestId,
      phase: request.phase,
      posture: request.posture,
      products,
    }),
  ).byteLength;
}
export function maxPartCount(request: TcgplayerMarketObservationRequest): number {
  return Math.max(1, Math.ceil(maxBatchTextBytes(request) / PART_TEXT_MAX_BYTES));
}
export const tcgplayerMarketObservationPartRecorded = "catalog.operator-session.market-observation-part-recorded";
export const tcgplayerMarketObservationBatchAdmitted = "catalog.operator-session.market-observation-batch-admitted";
export function parsePartPayload(
  v: unknown,
  requestInput: TcgplayerMarketObservationRequest,
): TcgplayerMarketObservationPartPayload {
  const r = parseTcgplayerMarketObservationRequest(requestInput),
    p = rec(v, ["batchId", "requestId", "phase", "partIndex", "text"], "invalid_part");
  if (typeof p.batchId !== "string" || !UUID.test(p.batchId) || p.requestId !== r.requestId || p.phase !== r.phase)
    bad("invalid_part_identity");
  const text = p.text as string;
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    !/^[\x00-\x7F]*$/.test(text) ||
    new TextEncoder().encode(text).byteLength > PART_TEXT_MAX_BYTES
  )
    bad("invalid_part_text");
  return {
    batchId: p.batchId as string,
    requestId: r.requestId as string,
    phase: r.phase as TcgplayerMarketObservationPhase,
    partIndex: integer(p.partIndex, 0, maxPartCount(r) - 1, "invalid_part_index"),
    text,
  };
}
export function parseAdmissionPayload(
  v: unknown,
  requestInput: TcgplayerMarketObservationRequest,
): TcgplayerMarketObservationAdmissionPayload {
  const r = parseTcgplayerMarketObservationRequest(requestInput),
    p = rec(
      v,
      [
        "batchId",
        "requestId",
        "phase",
        "contractVersion",
        "partCount",
        "textBytes",
        "digest",
        "grantId",
        "creatorMembershipId",
        "creatorUserId",
        "admittedAt",
      ],
      "invalid_admission",
    );
  if (
    typeof p.batchId !== "string" ||
    !UUID.test(p.batchId) ||
    typeof p.grantId !== "string" ||
    !UUID.test(p.grantId) ||
    p.requestId !== r.requestId ||
    p.phase !== r.phase ||
    p.contractVersion !== 1
  )
    bad("invalid_admission");
  const partCount = integer(p.partCount, 1, maxPartCount(r), "invalid_admission"),
    textBytes = integer(p.textBytes, 1, maxBatchTextBytes(r), "invalid_admission");
  if (
    Math.ceil(textBytes / PART_TEXT_MAX_BYTES) !== partCount ||
    typeof p.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(p.digest)
  )
    bad("invalid_admission");
  for (const id of [p.creatorMembershipId, p.creatorUserId])
    if (typeof id !== "string" || id.length < 1 || id.length > 128) bad("invalid_admission");
  return {
    batchId: p.batchId as string,
    requestId: r.requestId,
    phase: r.phase,
    contractVersion: 1,
    partCount,
    textBytes,
    digest: p.digest as string,
    grantId: p.grantId as string,
    creatorMembershipId: p.creatorMembershipId as string,
    creatorUserId: p.creatorUserId as string,
    admittedAt: instant(p.admittedAt, "invalid_admission"),
  };
}
export async function assembleAdmittedTcgplayerMarketObservationBatch(
  history: readonly TcgplayerMarketObservationHistoryEvent[],
  requestInput: TcgplayerMarketObservationRequest,
): Promise<TcgplayerMarketObservationBatch> {
  const r = parseTcgplayerMarketObservationRequest(requestInput);
  if (!Array.isArray(history) || history.length < 1) bad("invalid_history");
  for (let i = 0; i < history.length; i++) {
    const event = history[i];
    if (!event || typeof event !== "object" || event.streamVersion !== i + 1) bad("misordered_history");
  }
  const events = history.map((e) => {
    const x = rec(e, ["streamVersion", "data"], "invalid_history_event");
    return {
      streamVersion: integer(x.streamVersion, 1, Number.MAX_SAFE_INTEGER, "invalid_history_version"),
      data: x.data,
    };
  });
  let admission: TcgplayerMarketObservationAdmissionPayload | null = null;
  const partEvents: { streamVersion: number; payload: TcgplayerMarketObservationPartPayload }[] = [];
  for (const e of events) {
    let isAdmission = false;
    try {
      const a = parseAdmissionPayload(e.data, r);
      if (admission) bad("duplicate_admission");
      admission = a;
      isAdmission = true;
    } catch (error) {
      if (error instanceof TcgplayerMarketObservationContractError && error.code === "duplicate_admission") throw error;
    }
    if (!isAdmission) {
      try {
        partEvents.push({ streamVersion: e.streamVersion, payload: parsePartPayload(e.data, r) });
      } catch {
        bad("invalid_history_event");
      }
    }
  }
  if (!admission) bad("missing_admission");
  const admitted = admission as TcgplayerMarketObservationAdmissionPayload;
  if (partEvents.some((event) => event.payload.batchId !== admitted.batchId)) bad("foreign_part");
  if (partEvents.length !== admitted.partCount) bad("invalid_history_parts");
  const byIndex = new Map<number, { streamVersion: number; payload: TcgplayerMarketObservationPartPayload }>();
  for (const e of partEvents) {
    if (byIndex.has(e.payload.partIndex)) bad("duplicate_part");
    byIndex.set(e.payload.partIndex, e);
  }
  for (let i = 0; i < admitted.partCount; i++) {
    const e = byIndex.get(i) ?? bad("misordered_part");
    if (e.streamVersion !== i + 1) bad("misordered_part");
    if (i < admitted.partCount - 1 && new TextEncoder().encode(e.payload.text).byteLength !== PART_TEXT_MAX_BYTES)
      bad("short_part");
  }
  if (events.some((e) => e.streamVersion > admitted.partCount + 1)) bad("event_after_admission");
  const last = events.find((e) => e.streamVersion === admitted.partCount + 1);
  if (!last) bad("missing_admission");
  const text = Array.from({ length: admitted.partCount }, (_, i) => byIndex.get(i)!.payload.text).join("");
  if (
    new TextEncoder().encode(text).byteLength !== admitted.textBytes ||
    (await digestTcgplayerMarketObservationBatchText(text)) !== admitted.digest
  )
    bad("invalid_history_digest");
  return parseTcgplayerMarketObservationBatch(text, r);
}
