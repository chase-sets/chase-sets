import type { LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MarketHistoryAggregate,
  MarketHistorySeriesPoint,
} from "../../../features/item-detail/domain/item-detail-market-history";
import { loader } from "./market-history-loader";

const api = vi.hoisted(() => ({
  getProductMarketStatsSnapshot: vi.fn(),
  getProductRollupSeries: vi.fn(),
}));
vi.mock("@chase-sets/pricing/server", () => ({ createPricingRequestApiClient: () => api }));

function request(range = "90d"): LoaderFunctionArgs {
  return {
    request: new Request(`https://example.test/items/cat/history?productId=prod&range=${range}`),
    url: new URL(`https://example.test/items/cat/history?productId=prod&range=${range}`),
    pattern: "/items/:id/history",
    params: { id: "cat" },
    context: {},
  };
}

function aggregate(currencyCode: string): MarketHistoryAggregate {
  return {
    currencyCode,
    lastSoldAt: "2026-07-01",
    lastSoldPriceAmount: "25.00",
    medianPrice30d: "24.00",
    volume30d: 3,
    tradeCount30d: 3,
    medianPrice90d: "23.00",
    volume90d: 4,
    tradeCount90d: 4,
  };
}

function point(currencyCode: string): MarketHistorySeriesPoint {
  return {
    currencyCode,
    day: "2026-07-01",
    firstPriceAmount: "24.00",
    lastPriceAmount: "25.00",
    minPriceAmount: "24.00",
    maxPriceAmount: "25.00",
    medianPriceAmount: "24.50",
    unitVolume: 3,
    tradeCount: 3,
    verifiedTradeCount: 2,
  };
}

describe("item-detail market-history loader currency mapping", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("fetches stats once and every named currency series in Pricing order despite out-of-order completion", async () => {
    const aggregates = [aggregate("EUR"), aggregate("USD")];
    const marketState = { minAskAmount: "13.00", maxBidAmount: "10.00", spreadAmount: "3.00" };
    api.getProductMarketStatsSnapshot.mockResolvedValue({
      aggregates,
      marketState,
      statHygiene: { minimumTradeSample: 5 },
      displayPolicy: { showVerifiedMarkers: false },
    });
    let resolveEuro!: (value: { items: MarketHistorySeriesPoint[] }) => void;
    api.getProductRollupSeries.mockImplementation(({ currencyCode }: { currencyCode: string }) => {
      expect(api.getProductMarketStatsSnapshot).toHaveBeenCalledExactlyOnceWith({
        catalogItemId: "cat",
        productId: "prod",
      });
      return currencyCode === "EUR"
        ? new Promise<{ items: MarketHistorySeriesPoint[] }>((resolve) => {
            resolveEuro = resolve;
          })
        : Promise.resolve({ items: [point(currencyCode)] });
    });

    const pending = loader(request("1y"));
    await vi.waitFor(() => expect(api.getProductRollupSeries).toHaveBeenCalledTimes(2));
    resolveEuro({ items: [point("EUR")] });
    const response = await pending;
    expect(api.getProductRollupSeries.mock.calls.map(([input]) => input.currencyCode)).toEqual(["EUR", "USD"]);
    for (const [input] of api.getProductRollupSeries.mock.calls) {
      expect(input).toMatchObject({
        catalogItemId: "cat",
        productId: "prod",
        granularity: "weekly",
        from: expect.any(String),
        to: expect.any(String),
      });
    }
    expect(await response.json()).toEqual({
      range: "1y",
      minimumSample: 5,
      showVerifiedMarkers: false,
      series: [
        { currencyCode: "EUR", points: [point("EUR")] },
        { currencyCode: "USD", points: [point("USD")] },
      ],
      stats: { aggregates, marketState },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=30");
  });

  it("keeps a single non-USD currency without substituting a default", async () => {
    api.getProductMarketStatsSnapshot.mockResolvedValue({ aggregates: [aggregate("EUR")], marketState: null });
    api.getProductRollupSeries.mockResolvedValue({ items: [point("EUR")] });
    const response = await loader(request("invalid"));
    expect(api.getProductMarketStatsSnapshot).toHaveBeenCalledTimes(1);
    expect(api.getProductRollupSeries).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ currencyCode: "EUR", granularity: "daily" }),
    );
    expect(await response.json()).toMatchObject({
      range: "90d",
      minimumSample: 3,
      showVerifiedMarkers: true,
      stats: { aggregates: [aggregate("EUR")] },
      series: [{ currencyCode: "EUR", points: [point("EUR")] }],
    });
  });

  it("requests stats once and no series when stats have no aggregates", async () => {
    api.getProductMarketStatsSnapshot.mockResolvedValue({ aggregates: [], marketState: null });
    const response = await loader(request());
    expect(await response.json()).toEqual({
      range: "90d",
      minimumSample: 3,
      showVerifiedMarkers: true,
      series: [],
      stats: { aggregates: [], marketState: null },
    });
    expect(api.getProductMarketStatsSnapshot).toHaveBeenCalledTimes(1);
    expect(api.getProductRollupSeries).not.toHaveBeenCalled();
  });
});
