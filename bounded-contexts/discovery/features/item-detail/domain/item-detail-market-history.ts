/**
 * Range-selector <-> pricing query-API mapping for the item-detail market
 * panel. Shared by the market-history resource-route loader (server)
 * and the range-selector UI (client) so both sides agree on the same four
 * ranges and the same granularity-per-range choice without duplicating the
 * mapping.
 *
 * Granularity choice is a deliberate response-size cap, not a query-API
 * default: 30d/90d stay at daily resolution (a meaningful point per day over
 * a short window); 1y steps up to weekly (365 daily points would be a lot of
 * SVG geometry for marginal readability gain); "all" steps to monthly with a
 * pragmatic five-year lookback cap (unbounded "all" would let a
 * long-lived catalog item's range query grow without bound).
 */
export type MarketHistoryRangeKey = "30d" | "90d" | "1y" | "all";

export const MARKET_HISTORY_RANGE_KEYS: readonly MarketHistoryRangeKey[] = ["30d", "90d", "1y", "all"];

export function isMarketHistoryRangeKey(value: string | null | undefined): value is MarketHistoryRangeKey {
  return MARKET_HISTORY_RANGE_KEYS.includes(value as MarketHistoryRangeKey);
}

const RANGE_LOOKBACK_DAYS: Readonly<Record<MarketHistoryRangeKey, number>> = {
  "30d": 30,
  "90d": 90,
  "1y": 365,
  all: 1825,
};

const RANGE_GRANULARITY: Readonly<Record<MarketHistoryRangeKey, "daily" | "weekly" | "monthly">> = {
  "30d": "daily",
  "90d": "daily",
  "1y": "weekly",
  all: "monthly",
};

export type MarketHistoryRangeWindow = Readonly<{
  from: string;
  to: string;
  granularity: "daily" | "weekly" | "monthly";
}>;

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function resolveMarketHistoryRangeWindow(
  rangeKey: MarketHistoryRangeKey,
  now: Date = new Date(),
): MarketHistoryRangeWindow {
  const lookbackDays = RANGE_LOOKBACK_DAYS[rangeKey];
  const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  return {
    from: utcDateString(from),
    to: utcDateString(now),
    granularity: RANGE_GRANULARITY[rangeKey],
  };
}

/**
 * Discovery-local shapes for the market-rollups query API response.
 * Deliberately NOT imported from `@chase-sets/pricing/server` here: only
 * route-support/request-support files may import another context's `/server`
 * surface (see docs/architecture/bounded-context-structure.md), and these
 * types are consumed by domain/ui files outside that boundary. The shape is
 * a structural mirror of pricing's `ProductRollupSeriesPoint` /
 * `ProductMarketStatsSnapshot` -- the market-history-loader.ts route-support
 * module is the single seam that seeds this shape from the pricing response.
 */
export type MarketHistorySeriesPoint = Readonly<{
  day: string;
  firstPriceAmount: string | null;
  lastPriceAmount: string | null;
  minPriceAmount: string | null;
  maxPriceAmount: string | null;
  medianPriceAmount: string | null;
  unitVolume: number;
  tradeCount: number;
  verifiedTradeCount: number;
}>;

export type MarketHistoryAggregate = Readonly<{
  lastSoldAt: string | null;
  lastSoldPriceAmount: string | null;
  medianPrice30d: string | null;
  volume30d: number;
  tradeCount30d: number;
  medianPrice90d: string | null;
  volume90d: number;
  tradeCount90d: number;
}>;

export type MarketHistoryMarketState = Readonly<{
  minAskAmount: string | null;
  maxBidAmount: string | null;
  spreadAmount: string | null;
}>;

export type MarketHistoryStats = Readonly<{
  aggregate: MarketHistoryAggregate | null;
  marketState: MarketHistoryMarketState | null;
}>;

/** The minimum-sample threshold below which a median is honestly reported as unavailable, not shown. */
export const DEFAULT_MARKET_HISTORY_MINIMUM_SAMPLE = 3;

export type MarketHistoryResponse = Readonly<{
  range: MarketHistoryRangeKey;
  minimumSample: number;
  series: readonly MarketHistorySeriesPoint[];
  stats: MarketHistoryStats;
}>;
