export { getAccountRecommendation, listAccountRecommendations } from "./features/recommendations/read-model/queries";
export { createPricingRequestApiClient } from "./support/request-support/api-client";
/**
 * Platform-wide market analytics reads: imported by the platform-api
 * composition root to build platform-operations' `opsMarketAnalyticsCrossContext`
 * host port, bound to pricing's own database pool there -- platform-operations
 * never queries pricing's tables directly.
 */
export {
  getPlatformGmvSeries,
  getPlatformGmvForMonth,
  getPlatformKpiSummary,
  getPlatformLiquiditySummary,
  getTopCatalogItemsByGmv,
} from "./features/market-rollups/read-model/platform-queries";
export type {
  GetPlatformGmvSeriesParams,
  PlatformGmvSeriesPoint,
  PlatformKpiSummary,
  PlatformLiquiditySummary,
  PlatformRollupGranularity,
  TopCatalogItemGmv,
} from "./features/market-rollups/read-model/platform-queries";
export type {
  GetProductRollupSeriesParams,
  MarketStateSnapshotPoint,
  ProductMarketAggregate,
  ProductMarketStatsSnapshot,
  ProductRollupSeriesPoint,
  RollupGranularity,
} from "./support/request-support/api-client";
export { pricingRealtimeManifest } from "./support/realtime-support/topics";
export { ROLLUP_MINIMUM_TRADE_SAMPLE } from "./features/market-rollups/read-model/rollup-policy";
