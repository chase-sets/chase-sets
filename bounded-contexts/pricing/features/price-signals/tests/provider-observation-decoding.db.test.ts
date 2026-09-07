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
});
