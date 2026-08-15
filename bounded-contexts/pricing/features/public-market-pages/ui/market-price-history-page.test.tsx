// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicMarketPageData } from "../read-model/queries";
import { MarketPriceHistoryPage } from "./market-price-history-page";

const page = {
  catalogItemId: "cat_1",
  title: "Charizard ex",
  subtitle: "Obsidian Flames",
  slug: "charizard-ex",
  productId: "product_1",
  series: [
    {
      day: "2026-08-13",
      firstPriceAmount: "19.00",
      lastPriceAmount: "20.00",
      minPriceAmount: "18.00",
      maxPriceAmount: "21.00",
      medianPriceAmount: "20.00",
      unitVolume: 3,
      tradeCount: 3,
      verifiedTradeCount: 3,
    },
    {
      day: "2026-08-14",
      firstPriceAmount: "20.00",
      lastPriceAmount: "22.00",
      minPriceAmount: "20.00",
      maxPriceAmount: "23.00",
      medianPriceAmount: "22.00",
      unitVolume: 4,
      tradeCount: 4,
      verifiedTradeCount: 4,
    },
  ],
  aggregate: {
    lastSoldAt: "2026-08-14T15:00:00.000Z",
    lastSoldPriceAmount: "22.00",
    medianPrice30d: "21.00",
    volume30d: 7,
    tradeCount30d: 7,
    medianPrice90d: "20.00",
    volume90d: 12,
    tradeCount90d: 12,
    sellThroughRate: "0.50",
  },
  marketState: {
    day: "2026-08-14",
    activeListingCount: 6,
    minAskAmount: "24.00",
    openOfferCount: 2,
    maxBidAmount: "19.00",
    spreadAmount: "5.00",
  },
} satisfies PublicMarketPageData;

describe("MarketPriceHistoryPage", () => {
  it("renders populated chart and market-stat furniture without legacy surface chrome", () => {
    const html = renderToStaticMarkup(
      <MarketPriceHistoryPage page={page} marketplaceItemUrl="https://example.test/items/charizard-ex" />,
    );
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const chart = rendered.querySelector('[data-testid="market-price-history-chart-furniture"]');
    const stats = rendered.querySelector('[data-testid="market-price-history-stats-furniture"]');

    expect(chart?.textContent).toContain("Charizard ex");
    expect(stats?.textContent).toContain("$22.00");
    expect(stats?.textContent).toContain("$21.00");
    expect(chart?.querySelector(".surface-border")).toBeNull();
    expect(stats?.querySelector(".surface-border")).toBeNull();
  });
});
