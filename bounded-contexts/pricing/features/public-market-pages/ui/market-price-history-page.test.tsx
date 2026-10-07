// @vitest-environment jsdom

import { Heading, NumericValue } from "@chase-sets/design-system";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicMarketPageData } from "../read-model/queries";
import { MarketPriceHistoryPage } from "./market-price-history-page";

const page = {
  catalogItemId: "cat_1",
  title: "Charizard ex",
  subtitle: "Obsidian Flames",
  slug: "charizard-ex",
  productId: "product_1",
  liveAsks: [{ currencyCode: "USD", minAskAmount: "24.00", buyableListingCount: 3 }],
  unpricedBuyableListingCount: 0,
  series: [
    {
      currencyCode: "USD",
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
      currencyCode: "USD",
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
  aggregates: [
    {
      currencyCode: "USD",
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
  ],
  marketState: {
    day: "2026-08-14",
    activeListingCount: 6,
    minAskAmount: "24.00",
    openOfferCount: 2,
    maxBidAmount: "19.00",
    spreadAmount: "5.00",
  },
} satisfies PublicMarketPageData;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  try {
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

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
    expect(html).not.toContain("(USD)");
    expect(chart?.querySelector(".surface-border")).toBeNull();
    expect(stats?.querySelector(".surface-border")).toBeNull();
  });

  it("renders separate labeled chart and stats blocks with their own denominations", () => {
    const eur = {
      ...page.aggregates[0]!,
      currencyCode: "EUR",
      lastSoldPriceAmount: "25.00",
      medianPrice30d: "24.00",
      medianPrice90d: "23.00",
    };
    const html = renderToStaticMarkup(
      <MarketPriceHistoryPage
        page={{
          ...page,
          aggregates: [page.aggregates[0]!, eur],
          series: [...page.series, { ...page.series[0]!, currencyCode: "EUR", medianPriceAmount: "24.00" }],
        }}
        marketplaceItemUrl="https://example.test/items/charizard-ex"
      />,
    );
    const rendered = parse(html);
    const charts = rendered.querySelectorAll('[data-testid="market-price-history-chart-furniture"]');
    const stats = rendered.querySelectorAll('[data-testid="market-price-history-stats-furniture"]');
    expect(charts).toHaveLength(2);
    expect(stats).toHaveLength(2);
    expect(charts[0]?.textContent).toContain("USD");
    expect(charts[1]?.textContent).toContain("EUR");
    expect(stats[0]?.textContent).toContain("$22.00");
    expect(stats[1]?.textContent).toContain("€25.00");
    expect(stats[0]?.textContent).toContain("Starting at $24.00");
    expect(stats[1]?.textContent).not.toContain("Starting at");
  });

  it.each(["zero trades", "several trade currencies"])(
    "shows live asks once with %s, not the snapshot ask",
    (trades) => {
      const stats = parse(
        renderToStaticMarkup(
          <MarketPriceHistoryPage
            page={{
              ...page,
              series: [],
              aggregates:
                trades === "zero trades"
                  ? []
                  : [
                      { ...page.aggregates[0]!, currencyCode: "GBP" },
                      { ...page.aggregates[0]!, currencyCode: "JPY" },
                    ],
              liveAsks: [
                { currencyCode: "EUR", minAskAmount: "5.00", buyableListingCount: 2 },
                { currencyCode: "USD", minAskAmount: "4.00", buyableListingCount: 3 },
              ],
              unpricedBuyableListingCount: 1,
            }}
            marketplaceItemUrl="https://example.test/items/charizard-ex"
          />,
        ),
      );
      expect(stats.textContent?.match(/Starting at \$4\.00/g)).toHaveLength(1);
      expect(stats.textContent?.match(/Starting at €5\.00/g)).toHaveLength(1);
      expect(stats.textContent).not.toContain("24.00");
      expect(stats.textContent).not.toContain("Price unavailable");
      expect(stats.textContent).not.toContain("No live asks");
    },
  );

  it.each([
    ["exhausted or held supply", 3, 0, "No live asks"],
    ["no active listings", 0, 0, "No live asks"],
    ["only unpriced buyable supply", 3, 2, "Price unavailable"],
  ] as const)("renders %s without changing the snapshot count", (_name, activeListingCount, unpricedCount, text) => {
    const stats = renderStats({
      ...page,
      aggregates: [],
      series: [],
      marketState: { ...page.marketState, activeListingCount },
      liveAsks: [],
      unpricedBuyableListingCount: unpricedCount,
    });
    expect(stats.textContent).toContain(`Active listings${activeListingCount}${text}`);
    expect(stats.textContent).not.toContain("Starting at");
    expect(stats.textContent).not.toContain("24.00");
  });

  it("shows a single USD ask without any trade currency", () => {
    const stats = renderStats({
      ...page,
      aggregates: [],
      series: [],
      liveAsks: [{ currencyCode: "USD", minAskAmount: "4.00", buyableListingCount: 3 }],
    });
    expect(stats.textContent).toContain("Starting at $4.00");
    expect(stats.textContent).not.toContain("24.00");
  });
});

/**
 * The role class is derived from a bare design-system render, never written
 * here, so this suite cannot drift from the primitive it observes.
 */
const numericValueClassName = renderToStaticMarkup(<NumericValue>0</NumericValue>).match(/class="([^"]*)"/)?.[1] ?? "";
const moneyPattern = /^-?\$[\d,]+\.\d{2}$/;

function parse(html: string): HTMLDivElement {
  const rendered = document.createElement("div");
  rendered.innerHTML = html;
  return rendered;
}

function numericValues(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll("span")].filter((span) => span.className === numericValueClassName);
}

function textsOf(elements: readonly HTMLElement[]): string[] {
  return elements.map((element) => element.textContent ?? "").sort();
}

function renderStats(data: PublicMarketPageData): HTMLElement {
  const rendered = parse(
    renderToStaticMarkup(
      <MarketPriceHistoryPage page={data} marketplaceItemUrl="https://example.test/items/charizard-ex" />,
    ),
  );
  const stats = rendered.querySelector<HTMLElement>('[data-testid="market-price-history-stats-furniture"]');
  expect(stats).not.toBeNull();
  return stats as HTMLElement;
}

describe("MarketPriceHistoryPage mono market-data role carriers", () => {
  it("derives the role class from the design system", () => {
    expect(numericValueClassName).not.toBe("");
  });

  it("roles the three headline market values inside their level-2 headings without touching the heading classes", () => {
    const stats = renderStats(page);
    const carriers = numericValues(stats);
    const bareHeadingClassName =
      renderToStaticMarkup(
        <Heading level={2} visualSize={4}>
          0
        </Heading>,
      ).match(/class="([^"]*)"/)?.[1] ?? "";

    expect(bareHeadingClassName).not.toBe("");
    expect(textsOf(carriers)).toEqual(["$20.00", "$21.00", "$22.00"]);
    for (const carrier of carriers) {
      const heading = carrier.parentElement;
      expect(carrier.tagName).toBe("SPAN");
      expect(carrier.textContent).toMatch(moneyPattern);
      expect(heading?.tagName).toBe("H2");
      expect(heading?.className).toBe(bareHeadingClassName);
      for (const token of numericValueClassName.split(" ")) {
        expect(heading?.classList.contains(token)).toBe(false);
      }
    }
    // The minimum ask is interpolated into a sentence and stays unroled.
    expect(stats.textContent).toContain("$24.00");
    expect(carriers.some((carrier) => carrier.textContent === "$24.00")).toBe(false);
  });

  it("renders the no-data placeholder without a carrier when the headline values are null", () => {
    const stats = renderStats({
      ...page,
      aggregates: [{ ...page.aggregates[0]!, lastSoldPriceAmount: null, medianPrice30d: null, medianPrice90d: null }],
    });

    expect(stats.textContent?.match(/No data yet/g)).toHaveLength(3);
    expect(numericValues(stats)).toHaveLength(0);
  });
});
