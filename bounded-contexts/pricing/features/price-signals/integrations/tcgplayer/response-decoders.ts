type RecordValue = Readonly<Record<string, unknown>>;

export type DecodedPricePoint = Readonly<{
  skuId: number;
  marketPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
  priceCount: number | null;
  calculatedAt: string | null;
}>;

export type DecodedSale = Readonly<{
  condition: string;
  variant: string;
  language: string;
  quantity: number;
  listingType: string;
  customListingId: string;
  purchasePrice: number;
  shippingPrice: number;
  orderDate: string;
}>;

export type DecodedLatestSales = Readonly<{
  previousPage: "Yes" | "";
  nextPage: "Yes" | "";
  resultCount: number;
  totalResults: number;
  data: readonly DecodedSale[];
  rejectedRows: number;
}>;

export type DecodedListing = Readonly<{
  condition: string;
  printing: string;
  language: string;
  verifiedSeller: boolean;
  sellerKey: string;
  sellerId: string;
  sellerName: string;
  listingId: number;
  price: number;
  sellerShippingPrice: number;
}>;

export type DecodedListings = Readonly<{
  totalResults: number;
  results: readonly DecodedListing[];
  rejectedRows: number;
}>;

export type DecodedHistoryBucket = Readonly<{
  marketPrice: string | null;
  quantitySold: number;
  lowSalePrice: string | null;
  lowSalePriceWithShipping: string | null;
  highSalePrice: string | null;
  highSalePriceWithShipping: string | null;
  transactionCount: number;
  bucketStartDate: string;
}>;

export type DecodedHistoryResult = Readonly<{
  skuId: number;
  variant: string;
  language: string;
  condition: string;
  buckets: readonly DecodedHistoryBucket[];
}>;

export type DecodedPriceHistory = Readonly<{
  count: number;
  result: readonly DecodedHistoryResult[];
  rejectedRows: number;
}>;

const PRICE_POINT_KEYS = ["skuId", "marketPrice", "lowestPrice", "highestPrice", "priceCount", "calculatedAt"];
const SALES_ENVELOPE_KEYS = ["previousPage", "nextPage", "resultCount", "totalResults", "data"];
const SALE_KEYS = [
  "condition",
  "variant",
  "language",
  "quantity",
  "title",
  "listingType",
  "customListingId",
  "purchasePrice",
  "shippingPrice",
  "orderDate",
];
const LISTINGS_ENVELOPE_KEYS = ["errors", "results"];
const LISTINGS_RESULT_KEYS = ["totalResults", "resultId", "aggregations", "results"];
const LISTING_KEYS = [
  "directProduct",
  "goldSeller",
  "listingId",
  "channelId",
  "conditionId",
  "listedDate",
  "verifiedSeller",
  "directInventory",
  "rankedShippingPrice",
  "productId",
  "printing",
  "languageAbbreviation",
  "sellerName",
  "forwardFreight",
  "sellerShippingPrice",
  "language",
  "shippingPrice",
  "condition",
  "languageId",
  "score",
  "directSeller",
  "productConditionId",
  "sellerId",
  "listingType",
  "sellerRating",
  "sellerSales",
  "quantity",
  "sellerKey",
  "price",
  "customData",
  "soldDate",
];
const HISTORY_ENVELOPE_KEYS = ["count", "result"];
const HISTORY_RESULT_KEYS = [
  "skuId",
  "variant",
  "language",
  "condition",
  "averageDailyQuantitySold",
  "averageDailyTransactionCount",
  "totalQuantitySold",
  "totalTransactionCount",
  "trendingMarketPricePercentages",
  "buckets",
];
const HISTORY_BUCKET_KEYS = [
  "marketPrice",
  "quantitySold",
  "lowSalePrice",
  "lowSalePriceWithShipping",
  "highSalePrice",
  "highSalePriceWithShipping",
  "transactionCount",
  "bucketStartDate",
];

export function decodePricePoints(value: unknown): readonly DecodedPricePoint[] {
  if (!Array.isArray(value)) throw new Error("price-points-envelope-invalid");
  return value.map((item) => {
    const row = exactRecord(item, PRICE_POINT_KEYS, "price-point-item-invalid");
    return {
      skuId: integer(row.skuId, "price-point-sku-invalid", true),
      marketPrice: optionalMoneyNumber(row.marketPrice, "price-point-market-invalid"),
      lowestPrice: optionalMoneyNumber(row.lowestPrice, "price-point-low-invalid"),
      highestPrice: optionalMoneyNumber(row.highestPrice, "price-point-high-invalid"),
      priceCount: optionalInteger(row.priceCount, "price-point-count-invalid"),
      calculatedAt: optionalInstant(row.calculatedAt, "price-point-time-invalid"),
    };
  });
}

export function decodeLatestSales(value: unknown): DecodedLatestSales {
  const envelope = exactRecord(value, SALES_ENVELOPE_KEYS, "sales-envelope-invalid");
  if (!Array.isArray(envelope.data)) throw new Error("sales-envelope-invalid");
  let rejectedRows = 0;
  const data: DecodedSale[] = [];
  for (const item of envelope.data) {
    try {
      const row = exactRecord(item, SALE_KEYS, "sale-item-invalid");
      text(row.title, "sale-title-invalid", false);
      data.push({
        condition: text(row.condition, "sale-condition-invalid"),
        variant: text(row.variant, "sale-variant-invalid"),
        language: text(row.language, "sale-language-invalid"),
        quantity: integer(row.quantity, "sale-quantity-invalid", true),
        listingType: text(row.listingType, "sale-listing-type-invalid"),
        customListingId: text(row.customListingId, "sale-custom-listing-invalid", false),
        purchasePrice: moneyNumber(row.purchasePrice, "sale-price-invalid"),
        shippingPrice: moneyNumber(row.shippingPrice, "sale-shipping-invalid"),
        orderDate: instant(row.orderDate, "sale-time-invalid"),
      });
    } catch {
      rejectedRows += 1;
    }
  }
  return {
    previousPage: pageBoolean(envelope.previousPage),
    nextPage: pageBoolean(envelope.nextPage),
    resultCount: integer(envelope.resultCount, "sales-result-count-invalid"),
    totalResults: integer(envelope.totalResults, "sales-total-invalid"),
    data,
    rejectedRows,
  };
}

export function decodeListings(value: unknown): DecodedListings {
  const envelope = exactRecord(value, LISTINGS_ENVELOPE_KEYS, "listings-envelope-invalid");
  if (!Array.isArray(envelope.errors) || !Array.isArray(envelope.results) || envelope.results.length !== 1) {
    throw new Error("listings-envelope-invalid");
  }
  const page = exactRecord(envelope.results[0], LISTINGS_RESULT_KEYS, "listings-result-invalid");
  if (!Array.isArray(page.results)) throw new Error("listings-result-invalid");
  text(page.resultId, "listings-result-id-invalid", false);
  decodeAggregations(page.aggregations);
  let rejectedRows = 0;
  const results: DecodedListing[] = [];
  for (const item of page.results) {
    try {
      const row = exactRecord(item, LISTING_KEYS, "listing-item-invalid", ["listedDate", "soldDate"]);
      bool(row.directProduct, "listing-direct-product-invalid");
      bool(row.goldSeller, "listing-gold-seller-invalid");
      integer(row.channelId, "listing-channel-invalid");
      integer(row.conditionId, "listing-condition-id-invalid");
      optionalInstant(row.listedDate, "listing-listed-time-invalid");
      integer(row.directInventory, "listing-direct-inventory-invalid");
      moneyNumber(row.rankedShippingPrice, "listing-ranked-shipping-invalid");
      integer(row.productId, "listing-product-id-invalid", true);
      text(row.languageAbbreviation, "listing-language-abbreviation-invalid", false);
      bool(row.forwardFreight, "listing-forward-freight-invalid");
      moneyNumber(row.shippingPrice, "listing-total-shipping-invalid");
      integer(row.languageId, "listing-language-id-invalid");
      finiteNumber(row.score, "listing-score-invalid");
      bool(row.directSeller, "listing-direct-seller-invalid");
      integer(row.productConditionId, "listing-product-condition-id-invalid");
      text(row.listingType, "listing-type-invalid", false);
      finiteNumber(row.sellerRating, "listing-seller-rating-invalid");
      text(row.sellerSales, "listing-seller-sales-invalid", false);
      integer(row.quantity, "listing-quantity-invalid");
      optionalInstant(row.soldDate, "listing-sold-time-invalid");
      decodeCustomData(row.customData);
      results.push({
        condition: text(row.condition, "listing-condition-invalid"),
        printing: text(row.printing, "listing-printing-invalid"),
        language: text(row.language, "listing-language-invalid"),
        verifiedSeller: bool(row.verifiedSeller, "listing-verified-invalid"),
        sellerKey: text(row.sellerKey, "listing-seller-key-invalid", false),
        sellerId: text(row.sellerId, "listing-seller-id-invalid", false),
        sellerName: text(row.sellerName, "listing-seller-name-invalid", false),
        listingId: integer(row.listingId, "listing-id-invalid"),
        price: moneyNumber(row.price, "listing-price-invalid"),
        sellerShippingPrice: moneyNumber(row.sellerShippingPrice, "listing-shipping-invalid"),
      });
    } catch {
      rejectedRows += 1;
    }
  }
  return { totalResults: integer(page.totalResults, "listings-total-invalid"), results, rejectedRows };
}

export function decodePriceHistory(value: unknown): DecodedPriceHistory {
  const envelope = exactRecord(value, HISTORY_ENVELOPE_KEYS, "history-envelope-invalid");
  if (!Array.isArray(envelope.result)) throw new Error("history-envelope-invalid");
  let rejectedRows = 0;
  const result: DecodedHistoryResult[] = [];
  for (const item of envelope.result) {
    try {
      const row = exactRecord(item, HISTORY_RESULT_KEYS, "history-result-invalid");
      exactRecord(row.trendingMarketPricePercentages, [], "history-trending-invalid");
      if (!Array.isArray(row.buckets)) throw new Error("history-buckets-invalid");
      numericString(row.averageDailyQuantitySold, "history-average-quantity-invalid");
      numericString(row.averageDailyTransactionCount, "history-average-transactions-invalid");
      integerString(row.totalQuantitySold, "history-total-quantity-invalid");
      integerString(row.totalTransactionCount, "history-total-transactions-invalid");
      const buckets: DecodedHistoryBucket[] = [];
      for (const itemBucket of row.buckets) {
        try {
          const bucket = exactRecord(itemBucket, HISTORY_BUCKET_KEYS, "history-bucket-invalid");
          buckets.push({
            marketPrice: moneyStringOrEmpty(bucket.marketPrice, "history-market-invalid"),
            quantitySold: integerString(bucket.quantitySold, "history-quantity-invalid"),
            lowSalePrice: moneyStringOrEmpty(bucket.lowSalePrice, "history-low-invalid"),
            lowSalePriceWithShipping: moneyStringOrEmpty(
              bucket.lowSalePriceWithShipping,
              "history-low-delivered-invalid",
            ),
            highSalePrice: moneyStringOrEmpty(bucket.highSalePrice, "history-high-invalid"),
            highSalePriceWithShipping: moneyStringOrEmpty(
              bucket.highSalePriceWithShipping,
              "history-high-delivered-invalid",
            ),
            transactionCount: integerString(bucket.transactionCount, "history-transactions-invalid"),
            bucketStartDate: instant(bucket.bucketStartDate, "history-week-invalid"),
          });
        } catch {
          rejectedRows += 1;
        }
      }
      result.push({
        skuId: integerString(row.skuId, "history-sku-invalid", true),
        variant: text(row.variant, "history-variant-invalid"),
        language: text(row.language, "history-language-invalid"),
        condition: text(row.condition, "history-condition-invalid"),
        buckets,
      });
    } catch {
      rejectedRows += 1;
    }
  }
  return { count: integer(envelope.count, "history-count-invalid"), result, rejectedRows };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
  optionalKeys: readonly string[] = [],
): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error(code);
  if (keys.some((key) => !optionalKeys.includes(key) && !Object.hasOwn(row, key))) throw new Error(code);
  return row;
}

function decodeAggregations(value: unknown): void {
  const aggregations = exactRecord(
    value,
    ["condition", "quantity", "listingType", "language", "printing"],
    "listings-aggregations-invalid",
    ["condition", "quantity", "listingType", "language", "printing"],
  );
  for (const key of ["condition", "quantity", "listingType", "language", "printing"] as const) {
    const entries = aggregations[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error("listings-aggregations-invalid");
    for (const entry of entries) {
      const aggregation = exactRecord(entry, ["value", "count"], "listings-aggregation-invalid");
      text(aggregation.value, "listings-aggregation-value-invalid", false);
      integer(aggregation.count, "listings-aggregation-count-invalid");
    }
  }
}

function decodeCustomData(value: unknown): void {
  const customData = exactRecord(value, ["images", "title", "description", "linkId"], "listing-custom-data-invalid", [
    "title",
    "description",
    "linkId",
  ]);
  if (!Array.isArray(customData.images) || customData.images.some((image) => typeof image !== "string")) {
    throw new Error("listing-custom-data-invalid");
  }
  for (const key of ["title", "description", "linkId"] as const) {
    if (customData[key] !== undefined) text(customData[key], `listing-custom-data-${key}-invalid`, false);
  }
}

function integer(value: unknown, code: string, positive = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0) ||
    value > 2_147_483_647
  ) {
    throw new Error(code);
  }
  return value;
}

function optionalInteger(value: unknown, code: string): number | null {
  return value === null || value === undefined ? null : integer(value, code);
}

function integerString(value: unknown, code: string, positive = false): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(code);
  return integer(Number(value), code, positive);
}

function moneyNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 9_999_999_999.99)
    throw new Error(code);
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) throw new Error(code);
  return value;
}

function finiteNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function optionalMoneyNumber(value: unknown, code: string): number | null {
  return value === null || value === undefined ? null : moneyNumber(value, code);
}

function moneyStringOrEmpty(value: unknown, code: string): string | null {
  if (value === "") return null;
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 9_999_999_999.99) return null;
  return parsed.toFixed(2);
}

function numericString(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error(code);
  }
  return value;
}

function text(value: unknown, code: string, required = true): string {
  if (typeof value !== "string" || (required && !value.trim())) throw new Error(code);
  return value;
}

function bool(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function pageBoolean(value: unknown): "Yes" | "" {
  if (value !== "Yes" && value !== "") throw new Error("page-boolean-invalid");
  return value;
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(code);
  return parsed.toISOString();
}

function optionalInstant(value: unknown, code: string): string | null {
  return value === null || value === undefined || value === "" ? null : instant(value, code);
}
