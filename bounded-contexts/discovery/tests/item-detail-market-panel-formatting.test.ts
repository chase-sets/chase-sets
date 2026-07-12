import { describe, expect, it } from "vitest";
import type { ProductMarketAggregate, ProductRollupSeriesPoint } from "@chase-sets/pricing/server";
import {
  formatLastSold,
  formatMedianWindow,
  formatSpread,
  formatVerifiedSaleMarkerLabel,
} from "../features/item-detail/domain/item-detail-market-panel-formatting";

function aggregate(overrides: Partial<ProductMarketAggregate> = {}): ProductMarketAggregate {
  return {
    lastSoldAt: null,
    lastSoldPriceAmount: null,
    medianPrice30d: null,
    volume30d: 0,
    tradeCount30d: 0,
    medianPrice90d: null,
    volume90d: 0,
    tradeCount90d: 0,
    sellThroughRate: null,
    ...overrides,
  };
}

describe("formatLastSold", () => {
  it("reports no sales yet when there is no aggregate row", () => {
    expect(formatLastSold(null)).toEqual({ value: "No sales yet", note: null });
  });

  it("formats the last-sold price and date when present", () => {
    const result = formatLastSold(aggregate({ lastSoldAt: "2026-07-01T12:00:00.000Z", lastSoldPriceAmount: "12.00" }));
    expect(result.value).toBe("$12.00");
    expect(result.note).toContain("Sold");
  });
});

describe("formatMedianWindow", () => {
  it("formats the median price and unit volume when the sample is sufficient", () => {
    const result = formatMedianWindow(aggregate({ medianPrice30d: "11.00", volume30d: 5, tradeCount30d: 5 }), "30d", 3);
    expect(result.value).toBe("$11.00");
    expect(result.note).toBe("5 units sold");
  });

  it("reports no sales in the window when trade count is zero", () => {
    const result = formatMedianWindow(aggregate(), "90d", 3);
    expect(result.value).toBe("Unavailable");
    expect(result.note).toBe("No sales in the last 90 days");
  });

  it("gives an honest, specific note when the sample is below the minimum threshold", () => {
    const result = formatMedianWindow(aggregate({ tradeCount90d: 2, volume90d: 2 }), "90d", 3);
    expect(result.value).toBe("Unavailable");
    expect(result.note).toBe("2 sales in 90 days — median shown at 3+ sales");
  });

  it("uses the singular sale/unit copy at exactly one trade", () => {
    const result = formatMedianWindow(aggregate({ tradeCount30d: 1, volume30d: 1 }), "30d", 3);
    expect(result.note).toBe("1 sale in 30 days — median shown at 3+ sales");
  });
});

describe("formatSpread", () => {
  it("reports unavailable when there is no ask or bid", () => {
    expect(formatSpread(null)).toEqual({ value: "Unavailable", note: null });
    expect(formatSpread({ minAskAmount: null, maxBidAmount: null, spreadAmount: null })).toEqual({
      value: "Unavailable",
      note: null,
    });
  });

  it("formats the spread with both ask and bid present", () => {
    const result = formatSpread({ minAskAmount: "13.00", maxBidAmount: "10.00", spreadAmount: "3.00" });
    expect(result.value).toBe("$3.00");
    expect(result.note).toBe("$13.00 ask / $10.00 bid");
  });

  it("falls back to ask-only framing when there are no open offers", () => {
    const result = formatSpread({ minAskAmount: "13.00", maxBidAmount: null, spreadAmount: null });
    expect(result.value).toBe("$13.00");
    expect(result.note).toBe("Ask only — no open offers");
  });

  it("falls back to bid-only framing when there are no active listings", () => {
    const result = formatSpread({ minAskAmount: null, maxBidAmount: "10.00", spreadAmount: null });
    expect(result.value).toBe("$10.00");
    expect(result.note).toBe("Bid only — no active listings");
  });
});

describe("formatVerifiedSaleMarkerLabel", () => {
  it("builds an accessible label with price and date", () => {
    const point: ProductRollupSeriesPoint = {
      day: "2026-07-01",
      firstPriceAmount: "10.00",
      lastPriceAmount: "12.00",
      minPriceAmount: "10.00",
      maxPriceAmount: "12.00",
      medianPriceAmount: "11.00",
      unitVolume: 3,
      tradeCount: 3,
      verifiedTradeCount: 3,
    };

    expect(formatVerifiedSaleMarkerLabel(point)).toBe("Verified sale, $12.00, 2026-07-01");
  });
});
