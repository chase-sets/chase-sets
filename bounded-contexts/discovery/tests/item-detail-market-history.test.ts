import { describe, expect, it } from "vitest";
import {
  isMarketHistoryRangeKey,
  MARKET_HISTORY_RANGE_KEYS,
  resolveMarketHistoryRangeWindow,
} from "../features/item-detail/domain/item-detail-market-history";

const now = new Date("2026-07-09T12:00:00.000Z");

describe("isMarketHistoryRangeKey", () => {
  it("accepts every declared range key", () => {
    for (const key of MARKET_HISTORY_RANGE_KEYS) {
      expect(isMarketHistoryRangeKey(key)).toBe(true);
    }
  });

  it("rejects unknown, null, and undefined values", () => {
    expect(isMarketHistoryRangeKey("6m")).toBe(false);
    expect(isMarketHistoryRangeKey(null)).toBe(false);
    expect(isMarketHistoryRangeKey(undefined)).toBe(false);
  });
});

describe("resolveMarketHistoryRangeWindow", () => {
  it("resolves 30d to a 30-day daily window", () => {
    expect(resolveMarketHistoryRangeWindow("30d", now)).toEqual({
      from: "2026-06-09",
      to: "2026-07-09",
      granularity: "daily",
    });
  });

  it("resolves 90d to a 90-day daily window", () => {
    expect(resolveMarketHistoryRangeWindow("90d", now)).toEqual({
      from: "2026-04-10",
      to: "2026-07-09",
      granularity: "daily",
    });
  });

  it("resolves 1y to a 365-day weekly window", () => {
    const window = resolveMarketHistoryRangeWindow("1y", now);
    expect(window.granularity).toBe("weekly");
    expect(window.to).toBe("2026-07-09");
    expect(window.from).toBe("2025-07-09");
  });

  it("resolves all to a bounded monthly window rather than an unbounded scan", () => {
    const window = resolveMarketHistoryRangeWindow("all", now);
    expect(window.granularity).toBe("monthly");
    expect(window.to).toBe("2026-07-09");
    expect(new Date(window.from).getTime()).toBeLessThan(new Date(window.to).getTime());
  });
});
