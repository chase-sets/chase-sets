import { describe, expect, it } from "vitest";
import {
  decodeLatestSales,
  decodeListings,
  decodePriceHistory,
  decodePricePoints,
} from "../integrations/tcgplayer/response-decoders";

describe("closed provider response decoders", () => {
  it("rejects malformed envelopes, nested unknown keys, fractions, overflow, excess money precision, and bad timestamps", () => {
    expect(() => decodePricePoints({})).toThrow("price-points-envelope-invalid");
    expect(() =>
      decodePricePoints([
        {
          skuId: 1,
          marketPrice: 1.001,
          lowestPrice: 1,
          highestPrice: 1,
          priceCount: 1,
          calculatedAt: "2026-09-01T00:00:00Z",
        },
      ]),
    ).toThrow("price-point-market-invalid");
    expect(() =>
      decodeLatestSales({ previousPage: "", nextPage: "Maybe", resultCount: 0, totalResults: 0, data: [] }),
    ).toThrow("page-boolean-invalid");
    expect(() =>
      decodeListings({
        errors: [],
        results: [{ totalResults: 0, resultId: "synthetic", aggregations: {}, results: [], unknown: true }],
      }),
    ).toThrow("listings-result-invalid");
    expect(() => decodePriceHistory({ count: 1.5, result: [] })).toThrow("history-count-invalid");
  });

  it("rejects invalid items independently while retaining valid siblings", () => {
    const decoded = decodeLatestSales({
      previousPage: "",
      nextPage: "",
      resultCount: 2,
      totalResults: 2,
      data: [
        {
          condition: "Near Mint",
          variant: "Normal",
          language: "English",
          quantity: 1,
          title: "synthetic",
          listingType: "All",
          customListingId: "synthetic",
          purchasePrice: 5,
          shippingPrice: 0,
          orderDate: "2026-09-01T00:00:00Z",
        },
        {
          condition: "Near Mint",
          variant: "Normal",
          language: "English",
          quantity: 0,
          title: "synthetic",
          listingType: "All",
          customListingId: "synthetic",
          purchasePrice: 5,
          shippingPrice: 0,
          orderDate: "not-a-time",
        },
      ],
    });
    expect(decoded.data).toHaveLength(1);
    expect(decoded.rejectedRows).toBe(1);
  });

  it("requires every sales envelope and item field", () => {
    for (const field of ["previousPage", "nextPage", "resultCount", "totalResults", "data"] as const) {
      const envelope = validSalesEnvelope() as Record<string, unknown>;
      delete envelope[field];
      expect(() => decodeLatestSales(envelope)).toThrow();
      const wrongType = validSalesEnvelope() as Record<string, unknown>;
      wrongType[field] = null;
      expect(() => decodeLatestSales(wrongType), `wrong type sales envelope.${field}`).toThrow();
    }
    for (const field of Object.keys(validSale())) {
      const envelope = validSalesEnvelope();
      delete (envelope.data[0] as Record<string, unknown>)[field];
      expect(decodeLatestSales(envelope).rejectedRows, `missing sale.${field}`).toBe(1);
      const wrongType = validSalesEnvelope();
      (wrongType.data[0] as Record<string, unknown>)[field] = null;
      expect(decodeLatestSales(wrongType).rejectedRows, `wrong type sale.${field}`).toBe(1);
    }
  });

  it("requires and types every listing envelope, result, item, aggregation, and custom-data field", () => {
    for (const field of ["errors", "results"] as const) {
      const envelope = validListingsEnvelope() as Record<string, unknown>;
      delete envelope[field];
      expect(() => decodeListings(envelope)).toThrow();
      const wrongType = validListingsEnvelope() as Record<string, unknown>;
      wrongType[field] = null;
      expect(() => decodeListings(wrongType), `wrong type listings envelope.${field}`).toThrow();
    }
    for (const field of ["totalResults", "resultId", "aggregations", "results"] as const) {
      const envelope = validListingsEnvelope();
      delete (envelope.results[0] as Record<string, unknown>)[field];
      expect(() => decodeListings(envelope), `missing listings result.${field}`).toThrow();
      const wrongType = validListingsEnvelope();
      (wrongType.results[0] as Record<string, unknown>)[field] = null;
      expect(() => decodeListings(wrongType), `wrong type listings result.${field}`).toThrow();
    }
    for (const field of REQUIRED_LISTING_FIELDS) {
      const envelope = validListingsEnvelope();
      delete (envelope.results[0]!.results[0] as Record<string, unknown>)[field];
      expect(decodeListings(envelope).rejectedRows, `missing listing.${field}`).toBe(1);
    }
    for (const field of REQUIRED_LISTING_FIELDS) {
      const envelope = validListingsEnvelope();
      (envelope.results[0]!.results[0] as Record<string, unknown>)[field] = null;
      expect(decodeListings(envelope).rejectedRows, `wrong type listing.${field}`).toBe(1);
    }
    expect(decodeListings(validListingsEnvelope()).results).toHaveLength(1);
    expect(decodeListings(validListingsEnvelope({ omitOptionalDates: true })).results).toHaveLength(1);
    for (const field of ["listedDate", "soldDate"] as const) {
      const wrongType = validListingsEnvelope();
      (wrongType.results[0]!.results[0] as Record<string, unknown>)[field] = {};
      expect(decodeListings(wrongType).rejectedRows, `wrong type optional listing.${field}`).toBe(1);
    }

    const missingImages = validListingsEnvelope();
    delete (missingImages.results[0]!.results[0]!.customData as Record<string, unknown>).images;
    expect(decodeListings(missingImages).rejectedRows).toBe(1);
    const badAggregation = validListingsEnvelope();
    badAggregation.results[0]!.aggregations.condition = [{ value: "Near Mint", count: "1" as never }];
    expect(() => decodeListings(badAggregation)).toThrow("listings-aggregation-count-invalid");
    for (const aggregationField of ["condition", "quantity", "listingType", "language", "printing"] as const) {
      const wrongType = validListingsEnvelope();
      wrongType.results[0]!.aggregations[aggregationField] = null as never;
      expect(() => decodeListings(wrongType), `wrong type aggregations.${aggregationField}`).toThrow();
    }
    for (const field of ["value", "count"] as const) {
      const missing = validListingsEnvelope();
      delete (missing.results[0]!.aggregations.condition[0] as Record<string, unknown>)[field];
      expect(() => decodeListings(missing), `missing aggregation.${field}`).toThrow();
      const wrongType = validListingsEnvelope();
      (wrongType.results[0]!.aggregations.condition[0] as Record<string, unknown>)[field] = null;
      expect(() => decodeListings(wrongType), `wrong type aggregation.${field}`).toThrow();
    }
    for (const field of ["title", "description", "linkId"] as const) {
      const wrongType = validListingsEnvelope();
      (wrongType.results[0]!.results[0]!.customData as Record<string, unknown>)[field] = null;
      expect(decodeListings(wrongType).rejectedRows, `wrong type customData.${field}`).toBe(1);
    }
  });

  it("requires and types every history envelope, result, and bucket field", () => {
    for (const field of ["count", "result"] as const) {
      const envelope = validHistoryEnvelope() as Record<string, unknown>;
      delete envelope[field];
      expect(() => decodePriceHistory(envelope)).toThrow();
      const wrongType = validHistoryEnvelope() as Record<string, unknown>;
      wrongType[field] = null;
      expect(() => decodePriceHistory(wrongType), `wrong type history envelope.${field}`).toThrow();
    }
    for (const field of Object.keys(validHistoryResult())) {
      const envelope = validHistoryEnvelope();
      delete (envelope.result[0] as Record<string, unknown>)[field];
      expect(decodePriceHistory(envelope).rejectedRows, `missing history result.${field}`).toBe(1);
      const wrongType = validHistoryEnvelope();
      (wrongType.result[0] as Record<string, unknown>)[field] = null;
      expect(decodePriceHistory(wrongType).rejectedRows, `wrong type history result.${field}`).toBe(1);
    }
    for (const field of Object.keys(validHistoryBucket())) {
      const envelope = validHistoryEnvelope();
      delete (envelope.result[0]!.buckets[0] as Record<string, unknown>)[field];
      const decoded = decodePriceHistory(envelope);
      expect(decoded.rejectedRows, `missing history bucket.${field}`).toBe(1);
      expect(decoded.result[0]?.buckets).toEqual([]);
      const wrongType = validHistoryEnvelope();
      (wrongType.result[0]!.buckets[0] as Record<string, unknown>)[field] = null;
      const wrongDecoded = decodePriceHistory(wrongType);
      expect(wrongDecoded.rejectedRows, `wrong type history bucket.${field}`).toBe(1);
      expect(wrongDecoded.result[0]?.buckets).toEqual([]);
    }
  });

  it("keeps the mapper-used-field decoder bypass mutant red", () => {
    const sparse = validListingsEnvelope();
    const listing = sparse.results[0]!.results[0] as Record<string, unknown>;
    for (const field of REQUIRED_LISTING_FIELDS) {
      if (
        ![
          "condition",
          "printing",
          "language",
          "verifiedSeller",
          "sellerKey",
          "sellerId",
          "sellerName",
          "listingId",
          "price",
          "sellerShippingPrice",
        ].includes(field)
      ) {
        delete listing[field];
      }
    }
    const permissiveMapperOnlyMutant = (value: ReturnType<typeof validListingsEnvelope>) =>
      value.results[0]?.results.filter((row) => typeof row.condition === "string") ?? [];
    expect(permissiveMapperOnlyMutant(sparse)).toHaveLength(1);
    expect(decodeListings(sparse).rejectedRows).toBe(1);
  });
});

const REQUIRED_LISTING_FIELDS = [
  "directProduct",
  "goldSeller",
  "listingId",
  "channelId",
  "conditionId",
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
] as const;

function validSale() {
  return {
    condition: "Near Mint",
    variant: "Normal",
    language: "English",
    quantity: 1,
    title: "synthetic",
    listingType: "All",
    customListingId: "synthetic",
    purchasePrice: 5,
    shippingPrice: 0,
    orderDate: "2026-09-01T00:00:00.000Z",
  };
}

function validSalesEnvelope() {
  return { previousPage: "" as const, nextPage: "" as const, resultCount: 1, totalResults: 1, data: [validSale()] };
}

function validListingsEnvelope(options: Readonly<{ omitOptionalDates?: boolean }> = {}) {
  const listing: Record<string, unknown> = {
    directProduct: false,
    goldSeller: false,
    listingId: 1,
    channelId: 0,
    conditionId: 1,
    listedDate: "2026-09-01T00:00:00.000Z",
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
    sellerId: "synthetic",
    listingType: "standard",
    sellerRating: 100,
    sellerSales: "1",
    quantity: 1,
    sellerKey: "synthetic",
    price: 5,
    customData: { images: [], title: "synthetic", description: "synthetic", linkId: "synthetic" },
    soldDate: "2026-09-01T00:00:00.000Z",
  };
  if (options.omitOptionalDates) {
    delete listing.listedDate;
    delete listing.soldDate;
  }
  return {
    errors: [],
    results: [
      {
        totalResults: 1,
        resultId: "synthetic",
        aggregations: {
          condition: [{ value: "Near Mint", count: 1 }],
          quantity: [{ value: "1", count: 1 }],
          listingType: [{ value: "standard", count: 1 }],
          language: [{ value: "English", count: 1 }],
          printing: [{ value: "Normal", count: 1 }],
        },
        results: [listing],
      },
    ],
  };
}

function validHistoryBucket() {
  return {
    marketPrice: "5.00",
    quantitySold: "1",
    lowSalePrice: "5.00",
    lowSalePriceWithShipping: "5.00",
    highSalePrice: "5.00",
    highSalePriceWithShipping: "5.00",
    transactionCount: "1",
    bucketStartDate: "2026-09-01T00:00:00.000Z",
  };
}

function validHistoryResult() {
  return {
    skuId: "9001",
    variant: "Normal",
    language: "English",
    condition: "Near Mint",
    averageDailyQuantitySold: "1",
    averageDailyTransactionCount: "1",
    totalQuantitySold: "1",
    totalTransactionCount: "1",
    trendingMarketPricePercentages: {},
    buckets: [validHistoryBucket()],
  };
}

function validHistoryEnvelope() {
  return { count: 1, result: [validHistoryResult()] };
}
