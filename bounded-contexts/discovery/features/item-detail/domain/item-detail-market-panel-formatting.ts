import { t } from "@chase-sets/localization";
import { formatMoney, formatUpdatedAt } from "./item-detail-formatting";
import type {
  MarketHistoryAggregate,
  MarketHistoryMarketState,
  MarketHistorySeriesPoint,
} from "./item-detail-market-history";

/**
 * Neutral, factual framing only (m107 policy-page tone): every string
 * here states counts, prices, and dates -- never "good deal"/"below market"
 * editorializing, and never "estimate" (m122 snapshot-vs-estimate
 * delineation -- these are recorded trade snapshots, not estimates).
 */

export function formatLastSold(aggregate: MarketHistoryAggregate | null): { value: string; note: string | null } {
  if (!aggregate?.lastSoldAt) {
    return { value: t("discovery.features.itemDetail.ui.marketPanel.no.sales.yet"), note: null };
  }

  return {
    value: formatMoney(aggregate.lastSoldPriceAmount),
    note: t("discovery.features.itemDetail.ui.marketPanel.sold.on", { date: formatUpdatedAt(aggregate.lastSoldAt) }),
  };
}

export function formatMedianWindow(
  aggregate: MarketHistoryAggregate | null,
  window: "30d" | "90d",
  minimumSample: number,
): { value: string; note: string } {
  const medianPriceAmount =
    window === "30d" ? (aggregate?.medianPrice30d ?? null) : (aggregate?.medianPrice90d ?? null);
  const volume = window === "30d" ? (aggregate?.volume30d ?? 0) : (aggregate?.volume90d ?? 0);
  const tradeCount = window === "30d" ? (aggregate?.tradeCount30d ?? 0) : (aggregate?.tradeCount90d ?? 0);
  const windowDays = window === "30d" ? 30 : 90;

  if (medianPriceAmount) {
    return { value: formatMoney(medianPriceAmount), note: formatUnitsSold(volume) };
  }

  if (tradeCount === 0) {
    return {
      value: t("discovery.features.itemDetail.ui.marketPanel.unavailable"),
      note: t("discovery.features.itemDetail.ui.marketPanel.no.sales.in.window", { days: windowDays }),
    };
  }

  // Honest, specific insufficient-sample note (AC): "2 sales in 90 days —
  // median shown at 3+".
  return {
    value: t("discovery.features.itemDetail.ui.marketPanel.unavailable"),
    note: t(
      tradeCount === 1
        ? "discovery.features.itemDetail.ui.marketPanel.median.suppressed.singular"
        : "discovery.features.itemDetail.ui.marketPanel.median.suppressed.plural",
      { count: tradeCount, days: windowDays, minimumSample },
    ),
  };
}

function formatUnitsSold(volume: number): string {
  return t(
    volume === 1
      ? "discovery.features.itemDetail.ui.marketPanel.units.sold.singular"
      : "discovery.features.itemDetail.ui.marketPanel.units.sold.plural",
    { count: volume },
  );
}

export function formatSpread(marketState: MarketHistoryMarketState | null): { value: string; note: string | null } {
  if (!marketState || (!marketState.minAskAmount && !marketState.maxBidAmount)) {
    return { value: t("discovery.features.itemDetail.ui.marketPanel.unavailable"), note: null };
  }

  if (marketState.minAskAmount && marketState.maxBidAmount) {
    return {
      value: marketState.spreadAmount
        ? formatMoney(marketState.spreadAmount)
        : t("discovery.features.itemDetail.ui.marketPanel.unavailable"),
      note: t("discovery.features.itemDetail.ui.marketPanel.ask.and.bid", {
        ask: formatMoney(marketState.minAskAmount),
        bid: formatMoney(marketState.maxBidAmount),
      }),
    };
  }

  if (marketState.minAskAmount) {
    return {
      value: formatMoney(marketState.minAskAmount),
      note: t("discovery.features.itemDetail.ui.marketPanel.ask.only"),
    };
  }

  return {
    value: formatMoney(marketState.maxBidAmount),
    note: t("discovery.features.itemDetail.ui.marketPanel.bid.only"),
  };
}

export function formatVerifiedSaleMarkerLabel(point: MarketHistorySeriesPoint): string {
  return t("discovery.features.itemDetail.ui.marketPanel.verified.sale.marker", {
    price: formatMoney(point.lastPriceAmount),
    date: point.day,
  });
}
