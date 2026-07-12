import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPublicMarketPageRoutes } from "./route";
import type { PublicMarketPagesServices } from "./runtime";

function servicesStub(overrides: Partial<PublicMarketPagesServices> = {}): PublicMarketPagesServices {
  return {
    getPublicMarketPage: vi.fn().mockResolvedValue(null),
    listPublicMarketPageSlugs: vi.fn().mockResolvedValue([]),
    resolveDisplayPolicy: vi.fn().mockResolvedValue({
      showVerifiedMarkers: true,
      publicPageHistoryWindowDays: 180,
      publicPageCacheTtlSeconds: 86400,
    }),
    ...overrides,
  };
}

function mountApp(services: PublicMarketPagesServices) {
  const app = new Hono();
  app.route("/public/market-pages", createPublicMarketPageRoutes(services));
  return app;
}

describe("public market page routes", () => {
  it("returns the public page payload for a resolved slug, with no actor/session required", async () => {
    const page = {
      catalogItemId: "cat_1",
      title: "Charizard (Base Set)",
      subtitle: null,
      slug: "charizard-base-set-cat-1-abc123",
      productId: "cat_1::condition:near-mint",
      series: [],
      aggregate: null,
      marketState: null,
    };
    const services = servicesStub({ getPublicMarketPage: vi.fn().mockResolvedValue(page) });
    const app = mountApp(services);

    const response = await app.request("/public/market-pages/charizard-base-set-cat-1-abc123");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(services.getPublicMarketPage).toHaveBeenCalledWith("charizard-base-set-cat-1-abc123");
  });

  it("sets the public page's shared cache TTL from the resolved display policy (#4310)", async () => {
    const page = {
      catalogItemId: "cat_1",
      title: "Charizard (Base Set)",
      subtitle: null,
      slug: "charizard-base-set-cat-1-abc123",
      productId: null,
      series: [],
      aggregate: null,
      marketState: null,
    };
    const services = servicesStub({
      getPublicMarketPage: vi.fn().mockResolvedValue(page),
      resolveDisplayPolicy: vi.fn().mockResolvedValue({
        showVerifiedMarkers: true,
        publicPageHistoryWindowDays: 180,
        // A revised TTL -- proves the header is live-resolved, not a static literal.
        publicPageCacheTtlSeconds: 3600,
      }),
    });
    const app = mountApp(services);

    const response = await app.request("/public/market-pages/charizard-base-set-cat-1-abc123");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=60, s-maxage=3600, stale-while-revalidate=3600",
    );
  });

  it("404s for an unresolved slug", async () => {
    const app = mountApp(servicesStub());

    const response = await app.request("/public/market-pages/does-not-exist");

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("lists sitemap-feeding slugs with an optional limit", async () => {
    const entries = [{ slug: "charizard-base-set-cat-1-abc123", updatedAt: "2026-07-01T00:00:00.000Z" }];
    const services = servicesStub({ listPublicMarketPageSlugs: vi.fn().mockResolvedValue(entries) });
    const app = mountApp(services);

    const response = await app.request("/public/market-pages?limit=10");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: entries, count: 1 });
    expect(services.listPublicMarketPageSlugs).toHaveBeenCalledWith({ limit: 10 });
  });

  it("never includes account or transaction-party identifiers in the payload shape (privacy test)", async () => {
    const page = {
      catalogItemId: "cat_1",
      title: "Charizard (Base Set)",
      subtitle: null,
      slug: "charizard-base-set-cat-1-abc123",
      productId: "cat_1::condition:near-mint",
      series: [
        {
          day: "2026-07-01",
          firstPriceAmount: "18.00",
          lastPriceAmount: "20.00",
          minPriceAmount: "17.00",
          maxPriceAmount: "21.00",
          medianPriceAmount: "19.00",
          unitVolume: 3,
          tradeCount: 3,
          verifiedTradeCount: 3,
        },
      ],
      aggregate: {
        lastSoldAt: "2026-07-01T10:00:00.000Z",
        lastSoldPriceAmount: "20.00",
        medianPrice30d: "19.50",
        volume30d: 8,
        tradeCount30d: 8,
        medianPrice90d: "18.75",
        volume90d: 20,
        tradeCount90d: 20,
        sellThroughRate: "0.7500",
      },
      marketState: {
        day: "2026-07-01",
        activeListingCount: 5,
        minAskAmount: "21.00",
        openOfferCount: 2,
        maxBidAmount: "17.00",
        spreadAmount: "4.00",
      },
    };
    const app = mountApp(servicesStub({ getPublicMarketPage: vi.fn().mockResolvedValue(page) }));

    const response = await app.request("/public/market-pages/charizard-base-set-cat-1-abc123");
    const bodyText = await response.text();

    const forbiddenSubstrings = ["accountId", "account_id", "buyer", "seller", "sellerAccountId", "buyerAccountId"];
    for (const forbidden of forbiddenSubstrings) {
      expect(bodyText.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
