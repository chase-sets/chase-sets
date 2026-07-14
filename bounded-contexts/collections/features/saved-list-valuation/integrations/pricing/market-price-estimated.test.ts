import { describe, expect, it } from "vitest";
import { decodeMarketPriceEstimated } from "./market-price-estimated";

const valid = {
  schemaVersion: 1,
  catalogItemId: "cat_one",
  productId: "prd_one",
  estimateVersion: "estimate-1",
  window: { startedAt: "2026-07-01T00:00:00.000Z", endedAt: "2026-07-13T10:00:00.000Z" },
  amount: "10.5",
  currencyCode: "USD",
  band: { lowAmount: "8", highAmount: "12" },
  confidence: "medium",
  estimatedAt: "2026-07-13T10:00:00.000Z",
  freshUntil: "2026-07-14T10:00:00.000Z",
  disclosure: "public",
};

describe("MarketPriceEstimated consumer boundary", () => {
  it("normalizes only the Pricing fields Collections needs", () => {
    expect(decodeMarketPriceEstimated(valid)).toMatchObject({
      amount: "10.50",
      currencyCode: "usd",
      band: { lowAmount: "8.00", highAmount: "12.00" },
    });
  });

  it("rejects unsupported versions and invalid bands", () => {
    expect(() => decodeMarketPriceEstimated({ ...valid, schemaVersion: 2 })).toThrow("schema version");
    expect(() => decodeMarketPriceEstimated({ ...valid, band: { lowAmount: "11.00", highAmount: "12.00" } })).toThrow(
      "band must contain",
    );
  });
});
