// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketHistoryAggregate, MarketHistorySeriesPoint } from "../domain/item-detail-market-history";
import { ItemDetailMarketPanel } from "./item-detail-market-panel";
import { useItemDetailMarketHistory, type UseItemDetailMarketHistoryResult } from "./use-item-detail-market-history";

vi.mock("./use-item-detail-market-history", () => ({ useItemDetailMarketHistory: vi.fn() }));

function aggregate(currencyCode: string): MarketHistoryAggregate {
  return {
    currencyCode,
    lastSoldAt: "2026-07-02T12:00:00.000Z",
    lastSoldPriceAmount: "12.00",
    medianPrice30d: "11.00",
    volume30d: 5,
    tradeCount30d: 5,
    medianPrice90d: "10.00",
    volume90d: 7,
    tradeCount90d: 7,
  };
}

function points(currencyCode: string): MarketHistorySeriesPoint[] {
  return ["2026-07-01", "2026-07-02"].map((day, index) => ({
    currencyCode,
    day,
    firstPriceAmount: "10.00",
    lastPriceAmount: index === 0 ? "10.00" : "12.00",
    minPriceAmount: "10.00",
    maxPriceAmount: "12.00",
    medianPriceAmount: "11.00",
    unitVolume: 3,
    tradeCount: 3,
    verifiedTradeCount: 1,
  }));
}

function history(
  currencies: string[],
  overrides: Partial<UseItemDetailMarketHistoryResult> = {},
): UseItemDetailMarketHistoryResult {
  return {
    range: "90d",
    setRange: vi.fn(),
    series: currencies.map((currencyCode) => ({ currencyCode, points: points(currencyCode) })),
    stats: {
      aggregates: currencies.map(aggregate),
      marketState: { minAskAmount: "13.00", maxBidAmount: "10.00", spreadAmount: "3.00" },
    },
    minimumSample: 3,
    showVerifiedMarkers: true,
    loading: false,
    error: null,
    ...overrides,
  };
}

function renderPanel(data: UseItemDetailMarketHistoryResult, productId: string | null = "prod") {
  vi.mocked(useItemDetailMarketHistory).mockReturnValue(data);
  return render(<ItemDetailMarketPanel catalogItemId="cat" productId={productId} itemTitle="Test item" />);
}

function expectStat(label: string, value: string, note?: string) {
  const stat = screen.getByText(label).closest(".inset-surface");
  expect(stat).not.toBeNull();
  expect(within(stat as HTMLElement).getByText(value)).toBeTruthy();
  if (note) expect(within(stat as HTMLElement).getByText(note)).toBeTruthy();
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("item-detail market panel currencies", () => {
  it("renders two labeled groups in Pricing order with separate currency charts and one spread", () => {
    const data = history(["EUR", "USD"]);
    // Joining by currency must not depend on response-array position.
    renderPanel({ ...data, series: [...data.series].reverse() });
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Sales in EUR",
      "Sales in USD",
    ]);
    const charts = screen.getAllByRole("img", { name: "Trade price history for Test item" });
    expect(charts).toHaveLength(2);
    for (const [index, symbol] of ["€", "$"].entries()) {
      const group = screen.getByRole("heading", { name: index === 0 ? "Sales in EUR" : "Sales in USD" }).parentElement!;
      expect(within(group).getByText(`${symbol}12.00`)).toBeTruthy();
      expect(within(group).getByText(`${symbol}11.00`)).toBeTruthy();
      expect(within(group).getByText(`${symbol}10.00`)).toBeTruthy();
      const summary = document.getElementById(charts[index]!.getAttribute("aria-describedby")!);
      expect(summary?.textContent).toContain(`from ${symbol}10.00 to ${symbol}12.00`);
      expect(summary?.textContent).toContain(`Verified sale, ${symbol}12.00, 2026-07-02`);
    }
    expect(screen.getAllByText("Spread")).toHaveLength(1);
    expectStat("Spread", "$3.00", "$13.00 ask / $10.00 bid");
  });

  it("renders today's exact USD values in one unlabeled group and chart", () => {
    renderPanel(history(["USD"]));
    expect(screen.queryByRole("heading", { name: /^Sales in / })).toBeNull();
    expect(screen.getAllByRole("img", { name: "Trade price history for Test item" })).toHaveLength(1);
    expectStat("Last sold", "$12.00");
    expectStat("30-day median", "$11.00", "5 units sold");
    expectStat("90-day median", "$10.00", "7 units sold");
    expect(screen.getAllByText("Spread")).toHaveLength(1);
    expectStat("Spread", "$3.00", "$13.00 ask / $10.00 bid");
  });

  it("renders one unlabeled no-trade group and one empty chart with no currencies", () => {
    renderPanel(history([]));
    expect(screen.queryByRole("heading", { name: /^Sales in / })).toBeNull();
    expectStat("Last sold", "No sales yet");
    expectStat("30-day median", "Unavailable", "No sales in the last 30 days");
    expectStat("90-day median", "Unavailable", "No sales in the last 90 days");
    expect(screen.getAllByText("No sales recorded yet")).toHaveLength(1);
    expect(screen.queryByRole("img", { name: "Trade price history for Test item" })).toBeNull();
    expect(screen.getAllByText("Spread")).toHaveLength(1);
  });

  it("keeps one non-USD currency unlabeled and formats its chart in EUR", () => {
    renderPanel(history(["EUR"]));
    expect(screen.queryByRole("heading", { name: /^Sales in / })).toBeNull();
    expectStat("Last sold", "€12.00");
    expect(screen.getByText(/Sale price: 2 points, from €10.00 to €12.00/)).toBeTruthy();
  });

  it("keeps range changes shared across the currency charts and honors the marker policy", () => {
    const data = history(["EUR", "USD"], { showVerifiedMarkers: false });
    renderPanel(data);
    fireEvent.click(screen.getAllByRole("radio", { name: "30 days" })[1]!);
    expect(data.setRange).toHaveBeenCalledExactlyOnceWith("30d");
    expect(screen.queryByText(/Verified sale/)).toBeNull();
  });

  it("keeps loading, request errors, and condition selection states", () => {
    const view = renderPanel(history([], { loading: true, stats: null }));
    expect(screen.getByText("No sales recorded yet")).toBeTruthy();
    view.unmount();
    const errorView = renderPanel(history([], { error: "failed" }));
    expect(screen.getByText("Sales history unavailable")).toBeTruthy();
    expect(screen.queryByText("Spread")).toBeNull();
    errorView.unmount();
    renderPanel(history([]), null);
    expect(screen.getByText("Select a condition")).toBeTruthy();
  });
});
