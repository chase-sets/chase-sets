import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { createMarketRollupsRoutes } from "./route";
import type { MarketRollupsServices } from "./runtime";

function createServices(): MarketRollupsServices {
  return {
    runDailyRollupCloser: vi.fn(async () => ({
      rollupDaysRecomputed: 0,
      marketStateSnapshotsRecomputed: 0,
      productAggregatesRecomputed: 0,
      platformDaysRecomputed: 0,
    })),
    getPlatformGmvSeries: vi.fn(async () => []),
    getPlatformGmvForMonth: vi.fn(async () => "0.00"),
    getPlatformKpiSummary: vi.fn(async () => ({
      gmvAmount: "0.00",
      tradeCount: 0,
      orderCount: 0,
      unitVolume: 0,
      verifiedTradeCount: 0,
      activeBuyerCount: 0,
      activeSellerCount: 0,
    })),
    getPlatformLiquiditySummary: vi.fn(async () => ({
      asOfDay: "2026-07-01",
      sellThroughRate: null,
      medianSpreadAmount: null,
      spreadSampleCount: 0,
    })),
    getTopCatalogItemsByGmv: vi.fn(async () => []),
    getProductRollupSeries: vi.fn(async () => [
      {
        day: "2026-07-01",
        firstPriceAmount: "10.00",
        lastPriceAmount: "12.00",
        minPriceAmount: "9.50",
        maxPriceAmount: "12.00",
        medianPriceAmount: "11.00",
        unitVolume: 3,
        tradeCount: 3,
        verifiedTradeCount: 3,
      },
    ]),
    getMarketStateSnapshotSeries: vi.fn(async () => []),
    getProductMarketAggregate: vi.fn(async () => null),
    getProductMarketStatsSnapshot: vi.fn(async () => ({
      aggregate: {
        lastSoldAt: "2026-07-01T12:00:00.000Z",
        lastSoldPriceAmount: "12.00",
        medianPrice30d: "11.00",
        volume30d: 3,
        tradeCount30d: 3,
        medianPrice90d: null,
        volume90d: 3,
        tradeCount90d: 3,
        sellThroughRate: "0.5000",
      },
      marketState: {
        day: "2026-07-01",
        activeListingCount: 2,
        minAskAmount: "13.00",
        openOfferCount: 1,
        maxBidAmount: "10.00",
        spreadAmount: "3.00",
      },
    })),
  };
}

function buildApp(services = createServices()) {
  const app = new Hono<AuthenticatedApiEnv>();
  app.route("/market-rollups", createMarketRollupsRoutes(services));
  return app;
}

describe("pricing market-rollups API routes", () => {
  it("returns the product rollup series for a valid range", async () => {
    const services = createServices();
    const response = await buildApp(services).fetch(
      new Request("http://pricing.test/market-rollups/cat_1/prod_1/series?from=2026-06-01&to=2026-07-01"),
    );

    expect(response.status).toBe(200);
    expect(services.getProductRollupSeries).toHaveBeenCalledWith({
      catalogItemId: "cat_1",
      productId: "prod_1",
      from: "2026-06-01",
      to: "2026-07-01",
      granularity: undefined,
    });
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          day: "2026-07-01",
          firstPriceAmount: "10.00",
          lastPriceAmount: "12.00",
          minPriceAmount: "9.50",
          maxPriceAmount: "12.00",
          medianPriceAmount: "11.00",
          unitVolume: 3,
          tradeCount: 3,
          verifiedTradeCount: 3,
        },
      ],
    });
  });

  it("rejects a series request with a malformed date", async () => {
    const response = await buildApp().fetch(
      new Request("http://pricing.test/market-rollups/cat_1/prod_1/series?from=not-a-date&to=2026-07-01"),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a series request with an invalid granularity", async () => {
    const response = await buildApp().fetch(
      new Request(
        "http://pricing.test/market-rollups/cat_1/prod_1/series?from=2026-06-01&to=2026-07-01&granularity=hourly",
      ),
    );

    expect(response.status).toBe(400);
  });

  it("passes a supported granularity through to the query API", async () => {
    const services = createServices();
    await buildApp(services).fetch(
      new Request(
        "http://pricing.test/market-rollups/cat_1/prod_1/series?from=2026-01-01&to=2026-07-01&granularity=weekly",
      ),
    );

    expect(services.getProductRollupSeries).toHaveBeenCalledWith(expect.objectContaining({ granularity: "weekly" }));
  });

  it("returns the product market stats snapshot", async () => {
    const services = createServices();
    const response = await buildApp(services).fetch(
      new Request("http://pricing.test/market-rollups/cat_1/prod_1/stats"),
    );

    expect(response.status).toBe(200);
    expect(services.getProductMarketStatsSnapshot).toHaveBeenCalledWith({
      catalogItemId: "cat_1",
      productId: "prod_1",
    });
    const body = await response.json();
    expect(body.aggregate.lastSoldPriceAmount).toBe("12.00");
    expect(body.marketState.spreadAmount).toBe("3.00");
  });
});
