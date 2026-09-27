import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "./market-history-loader";

const api = vi.hoisted(() => ({
  getProductMarketStatsSnapshot: vi.fn(),
  getProductRollupSeries: vi.fn(),
}));
vi.mock("@chase-sets/pricing/server", () => ({ createPricingRequestApiClient: () => api }));

function request() {
  return {
    request: new Request("https://example.test/items/cat/history?productId=prod"),
    params: { id: "cat" },
  } as never;
}

describe("item-detail market-history loader currency mapping", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("fetches stats before only the most-traded currency series and keeps the mirror shape", async () => {
    const order: string[] = [];
    api.getProductMarketStatsSnapshot.mockImplementation(async () => {
      order.push("stats");
      return {
        aggregates: [
          {
            currencyCode: "EUR",
            lastSoldAt: null,
            lastSoldPriceAmount: "25.00",
            medianPrice30d: "24.00",
            volume30d: 3,
            tradeCount30d: 3,
            medianPrice90d: "23.00",
            volume90d: 3,
            tradeCount90d: 3,
          },
          { currencyCode: "USD" },
        ],
        marketState: null,
      };
    });
    api.getProductRollupSeries.mockImplementation(async () => {
      order.push("series");
      return { items: [{ currencyCode: "EUR", day: "2026-07-01", tradeCount: 3 }] };
    });

    const response = await loader(request());
    const data = await response.json();
    expect(order).toEqual(["stats", "series"]);
    expect(api.getProductRollupSeries).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: "EUR" }));
    expect(data.series).toEqual([{ day: "2026-07-01", tradeCount: 3 }]);
    expect(data.stats.aggregate.lastSoldPriceAmount).toBe("25.00");
    expect(data.stats.aggregate).not.toHaveProperty("currencyCode");
  });

  it("does not request a series when stats have no aggregates", async () => {
    api.getProductMarketStatsSnapshot.mockResolvedValue({ aggregates: [], marketState: null });
    const response = await loader(request());
    expect((await response.json()).series).toEqual([]);
    expect(api.getProductRollupSeries).not.toHaveBeenCalled();
  });
});
