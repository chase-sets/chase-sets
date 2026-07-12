import { t } from "@chase-sets/localization";
import {
  MarketplaceEmptyState,
  SegmentedControl,
  Stack,
  Stat,
  StatGrid,
  TimeSeriesChart,
  type TimeSeriesSeries,
} from "@chase-sets/design-system";
import {
  formatLastSold,
  formatMedianWindow,
  formatSpread,
  formatVerifiedSaleMarkerLabel,
} from "../domain/item-detail-market-panel-formatting";
import {
  MARKET_HISTORY_RANGE_KEYS,
  type MarketHistoryRangeKey,
  type MarketHistorySeriesPoint,
} from "../domain/item-detail-market-history";
import { useItemDetailMarketHistory } from "./use-item-detail-market-history";

function rangeSelectorLabel(range: MarketHistoryRangeKey): string {
  switch (range) {
    case "30d":
      return t("discovery.features.itemDetail.ui.marketPanel.range.30d");
    case "90d":
      return t("discovery.features.itemDetail.ui.marketPanel.range.90d");
    case "1y":
      return t("discovery.features.itemDetail.ui.marketPanel.range.1y");
    case "all":
      return t("discovery.features.itemDetail.ui.marketPanel.range.all");
  }
}

function dayTimestamp(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * `showVerifiedMarkers` is pricing's market-analytics display policy toggle --
 * an admin can turn verified-sale chart markers off platform-wide without a
 * deploy. Defaults true (this milestone's launch behavior).
 */
function toChartSeries(
  points: readonly MarketHistorySeriesPoint[],
  showVerifiedMarkers: boolean,
): readonly TimeSeriesSeries[] {
  const plottable = points.filter((point): point is MarketHistorySeriesPoint & { lastPriceAmount: string } =>
    Boolean(point.lastPriceAmount),
  );

  return [
    {
      id: "trade-price",
      name: t("discovery.features.itemDetail.ui.marketPanel.chart.seriesName"),
      tone: "accent",
      curve: "line",
      points: plottable.map((point) => ({
        timestamp: dayTimestamp(point.day),
        value: Number(point.lastPriceAmount),
      })),
      band: plottable
        .filter((point) => point.minPriceAmount !== null && point.maxPriceAmount !== null)
        .map((point) => ({
          timestamp: dayTimestamp(point.day),
          min: Number(point.minPriceAmount),
          max: Number(point.maxPriceAmount),
        })),
      markers: showVerifiedMarkers
        ? plottable
            .filter((point) => point.verifiedTradeCount > 0)
            .map((point) => ({
              timestamp: dayTimestamp(point.day),
              value: Number(point.lastPriceAmount),
              label: formatVerifiedSaleMarkerLabel(point),
            }))
        : [],
    },
  ];
}

function formatChartValue(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export type ItemDetailMarketPanelProps = Readonly<{
  catalogItemId: string;
  productId: string | null;
  itemTitle: string;
}>;

/**
 * The item-detail market panel: price history, last-sold, 30/90-day
 * median + volume, and current depth (ask/bid/spread) for the selected
 * product/condition. Data flows through `useItemDetailMarketHistory`, which
 * owns both the initial fetch and the realtime refresh on a
 * `pricing.productMarketStats` patch (m106 hook). Neutral framing only
 * (m107 policy-page tone): numbers and ranges, never "good deal" language.
 */
export function ItemDetailMarketPanel({ catalogItemId, productId, itemTitle }: ItemDetailMarketPanelProps) {
  const { range, setRange, series, stats, minimumSample, showVerifiedMarkers, loading, error } =
    useItemDetailMarketHistory(catalogItemId, productId);

  if (!productId) {
    return (
      <MarketplaceEmptyState
        title={t("discovery.features.itemDetail.ui.marketPanel.select.condition.title")}
        description={t("discovery.features.itemDetail.ui.marketPanel.select.condition.description")}
      />
    );
  }

  if (error) {
    return (
      <MarketplaceEmptyState
        title={t("discovery.features.itemDetail.ui.marketPanel.error.title")}
        description={t("discovery.features.itemDetail.ui.marketPanel.error.description")}
      />
    );
  }

  const lastSold = formatLastSold(stats?.aggregate ?? null);
  const median30d = formatMedianWindow(stats?.aggregate ?? null, "30d", minimumSample);
  const median90d = formatMedianWindow(stats?.aggregate ?? null, "90d", minimumSample);
  const spread = formatSpread(stats?.marketState ?? null);
  const rangeSelector = (
    <SegmentedControl
      label={t("discovery.features.itemDetail.ui.marketPanel.range.selector.label")}
      value={range}
      onValueChange={(value) => {
        const nextRange = MARKET_HISTORY_RANGE_KEYS.find((key) => key === value);
        if (nextRange) {
          setRange(nextRange);
        }
      }}
      items={MARKET_HISTORY_RANGE_KEYS.map((key) => ({ value: key, label: rangeSelectorLabel(key) }))}
    />
  );

  return (
    <Stack gap={4}>
      <StatGrid columns={{ base: 1, sm: 2, lg: 4 }}>
        <Stat
          label={t("discovery.features.itemDetail.ui.marketPanel.lastSold.label")}
          value={lastSold.value}
          trend={lastSold.note}
        />
        <Stat
          label={t("discovery.features.itemDetail.ui.marketPanel.median30d.label")}
          value={median30d.value}
          trend={median30d.note}
        />
        <Stat
          label={t("discovery.features.itemDetail.ui.marketPanel.median90d.label")}
          value={median90d.value}
          trend={median90d.note}
        />
        <Stat
          label={t("discovery.features.itemDetail.ui.marketPanel.spread.label")}
          value={spread.value}
          trend={spread.note}
        />
      </StatGrid>
      <TimeSeriesChart
        label={t("discovery.features.itemDetail.ui.marketPanel.chart.label", { title: itemTitle })}
        series={loading ? [] : toChartSeries(series, showVerifiedMarkers)}
        rangeSelector={rangeSelector}
        formatValue={formatChartValue}
        emptyTitle={t("discovery.features.itemDetail.ui.marketPanel.chart.empty.title")}
        emptyDescription={t("discovery.features.itemDetail.ui.marketPanel.chart.empty.description")}
        insufficientTitle={t("discovery.features.itemDetail.ui.marketPanel.chart.insufficient.title")}
        insufficientDescription={t("discovery.features.itemDetail.ui.marketPanel.chart.insufficient.description")}
        minChartWidth={480}
      />
    </Stack>
  );
}
