const SALES_ENVELOPE_FIELDS = ["previousPage", "nextPage", "resultCount", "totalResults", "data"] as const;
const SALE_FIELDS = [
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
] as const;
const LISTINGS_ENVELOPE_FIELDS = ["errors", "results"] as const;
const LISTINGS_RESULT_FIELDS = ["totalResults", "resultId", "aggregations", "results"] as const;
const AGGREGATIONS_FIELDS = ["condition", "quantity", "listingType", "language", "printing"] as const;
const AGGREGATION_FIELDS = ["value", "count"] as const;
const LISTING_FIELDS = [
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
] as const;
const CUSTOM_DATA_FIELDS = ["images", "title", "description", "linkId"] as const;
const HISTORY_ENVELOPE_FIELDS = ["count", "result"] as const;
const HISTORY_RESULT_FIELDS = [
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
] as const;
const HISTORY_BUCKET_FIELDS = [
  "marketPrice",
  "quantitySold",
  "lowSalePrice",
  "lowSalePriceWithShipping",
  "highSalePrice",
  "highSalePriceWithShipping",
  "transactionCount",
  "bucketStartDate",
] as const;

export type ProviderOwnedResponseField =
  | (typeof SALES_ENVELOPE_FIELDS)[number]
  | (typeof SALE_FIELDS)[number]
  | (typeof LISTINGS_ENVELOPE_FIELDS)[number]
  | (typeof LISTINGS_RESULT_FIELDS)[number]
  | (typeof AGGREGATIONS_FIELDS)[number]
  | (typeof AGGREGATION_FIELDS)[number]
  | (typeof LISTING_FIELDS)[number]
  | (typeof CUSTOM_DATA_FIELDS)[number]
  | (typeof HISTORY_ENVELOPE_FIELDS)[number]
  | (typeof HISTORY_RESULT_FIELDS)[number]
  | (typeof HISTORY_BUCKET_FIELDS)[number];

export type ProviderResponseValueType = "array" | "boolean" | "null" | "number" | "object" | "string" | "undefined";

export type ProviderResponseObjectShapeSummary = Readonly<{
  objectCount: number;
  nonObjectCount: number;
  unexpectedFieldCount: number;
  fields: readonly Readonly<{
    field: ProviderOwnedResponseField;
    presentCount: number;
    missingCount: number;
    observedTypes: readonly ProviderResponseValueType[];
  }>[];
}>;

export type TcgplayerResponseFieldSummaryV1 = Readonly<{
  salesPages: readonly Readonly<{
    envelope: ProviderResponseObjectShapeSummary;
    items: ProviderResponseObjectShapeSummary;
  }>[];
  listingPages: readonly Readonly<{
    envelope: ProviderResponseObjectShapeSummary;
    result: ProviderResponseObjectShapeSummary;
    aggregations: ProviderResponseObjectShapeSummary;
    aggregationItems: ProviderResponseObjectShapeSummary;
    items: ProviderResponseObjectShapeSummary;
    customData: ProviderResponseObjectShapeSummary;
  }>[];
  history: Readonly<{
    envelope: ProviderResponseObjectShapeSummary;
    results: ProviderResponseObjectShapeSummary;
    buckets: ProviderResponseObjectShapeSummary;
  }> | null;
}>;

/**
 * Called synchronously at response receipt. Only allow-listed field names,
 * presence counts, and primitive type names cross this boundary; provider
 * values and unexpected field names are structurally absent from the result.
 */
export function summarizeSalesResponseAtReceipt(raw: unknown) {
  return {
    envelope: summarizeObjects([raw], SALES_ENVELOPE_FIELDS),
    items: summarizeObjects(arrayProperty(raw, "data"), SALE_FIELDS),
  } as const;
}

export function summarizeListingsResponseAtReceipt(raw: unknown) {
  const results = arrayProperty(raw, "results");
  const aggregationContainers = results.flatMap((entry) => objectProperty(entry, "aggregations"));
  const aggregationItems = aggregationContainers.flatMap((entry) =>
    AGGREGATIONS_FIELDS.flatMap((field) => arrayProperty(entry, field)),
  );
  const listings = results.flatMap((entry) => arrayProperty(entry, "results"));
  return {
    envelope: summarizeObjects([raw], LISTINGS_ENVELOPE_FIELDS),
    result: summarizeObjects(results, LISTINGS_RESULT_FIELDS),
    aggregations: summarizeObjects(aggregationContainers, AGGREGATIONS_FIELDS),
    aggregationItems: summarizeObjects(aggregationItems, AGGREGATION_FIELDS),
    items: summarizeObjects(listings, LISTING_FIELDS),
    customData: summarizeObjects(
      listings.flatMap((entry) => objectProperty(entry, "customData")),
      CUSTOM_DATA_FIELDS,
    ),
  } as const;
}

export function summarizeHistoryResponseAtReceipt(raw: unknown) {
  const results = arrayProperty(raw, "result");
  return {
    envelope: summarizeObjects([raw], HISTORY_ENVELOPE_FIELDS),
    results: summarizeObjects(results, HISTORY_RESULT_FIELDS),
    buckets: summarizeObjects(
      results.flatMap((entry) => arrayProperty(entry, "buckets")),
      HISTORY_BUCKET_FIELDS,
    ),
  } as const;
}

export function emptyTcgplayerResponseFieldSummary(): TcgplayerResponseFieldSummaryV1 {
  return { salesPages: [], listingPages: [], history: null };
}

function summarizeObjects(
  values: readonly unknown[],
  fields: readonly ProviderOwnedResponseField[],
): ProviderResponseObjectShapeSummary {
  const objects = values.filter(isRecord);
  return {
    objectCount: objects.length,
    nonObjectCount: values.length - objects.length,
    unexpectedFieldCount: objects.reduce(
      (count, value) =>
        count + Object.keys(value).filter((key) => !fields.includes(key as ProviderOwnedResponseField)).length,
      0,
    ),
    fields: fields.map((field) => {
      const present = objects.filter((value) => Object.hasOwn(value, field));
      return {
        field,
        presentCount: present.length,
        missingCount: objects.length - present.length,
        observedTypes: [...new Set(present.map((value) => valueType(value[field])))].sort(),
      };
    }),
  };
}

function arrayProperty(value: unknown, field: ProviderOwnedResponseField): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value[field])) return [];
  return value[field];
}

function objectProperty(value: unknown, field: ProviderOwnedResponseField): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !isRecord(value[field])) return [];
  return [value[field]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value: unknown): ProviderResponseValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "undefined") return "undefined";
  return "object";
}
