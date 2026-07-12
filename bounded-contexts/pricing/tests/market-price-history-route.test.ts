import { afterEach, describe, expect, it, vi } from "vitest";
import {
  headers as marketPriceHistoryHeaders,
  loader as marketPriceHistoryLoader,
} from "../routes/marketplace/market-price-history";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const samplePage = {
  catalogItemId: "cat_1",
  title: "Charizard (Base Set)",
  subtitle: "4/102 Holo",
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

describe("public market price-history route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the public market page without requiring any authenticated session call", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        requestedUrls.push(String(input));
        return Promise.resolve(jsonResponse(samplePage));
      }),
    );

    const result = await marketPriceHistoryLoader({
      request: new Request("https://chasesets.com/market/charizard-base-set-cat-1-abc123"),
      params: { slug: "charizard-base-set-cat-1-abc123" },
      context: undefined,
    } as never);

    expect(result.page.title).toBe("Charizard (Base Set)");
    expect(result.marketplaceItemUrl).toBe("https://marketplace.chasesets.com/items/charizard-base-set-cat-1-abc123");
    expect(result.canonicalUrl).toBe("https://chasesets.com/market/charizard-base-set-cat-1-abc123");
    // No preliminary /api/auth/session call -- this route never resolves an actor.
    expect(requestedUrls.some((url) => url.includes("/api/auth/session"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/api/marketplace/public/market-pages/"))).toBe(true);
  });

  it("404s when the slug does not resolve to a published catalog item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: { code: "not_found", message: "Market page not found." } }, 404)),
      ),
    );

    let caught: unknown;
    try {
      await marketPriceHistoryLoader({
        request: new Request("https://chasesets.com/market/does-not-exist"),
        params: { slug: "does-not-exist" },
        context: undefined,
      } as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });

  it("sets a long shared cache with a short browser max-age", () => {
    const result = marketPriceHistoryHeaders();
    expect(result["Cache-Control"]).toContain("s-maxage=86400");
    expect(result["Cache-Control"]).toContain("public");
  });
});
