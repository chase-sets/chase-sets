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
  getSellerCohortGmvSummary,
  getSellerCohortWeeklyGmv,
  getTopCatalogItemsByGmv,
} from "./features/market-rollups/read-model/platform-queries";
export type {
  GetPlatformGmvSeriesParams,
  PlatformGmvSeriesPoint,
  PlatformKpiSummary,
  PlatformLiquiditySummary,
  PlatformRollupGranularity,
  SellerCohortGmvSummary,
  SellerCohortWeeklyGmvPoint,
  TopCatalogItemGmv,
} from "./features/market-rollups/read-model/platform-queries";
export type {
  GetProductRollupSeriesParams,
  MarketStateSnapshotPoint,
  ProductMarketAggregate,
  ProductRollupSeriesPoint,
  RollupGranularity,
} from "./support/request-support/api-client";
export { pricingRealtimeManifest } from "./support/realtime-support/topics";
/**
 * The m110 platform-policy declarations for pricing's market-analytics
 * dials: assembled once, cross-context, by the `platform-api` composition
 * root's policy console registry (`deployables/platform-api/src/app.ts`) so
 * an admin can see and revise them without pricing exposing a dedicated
 * console route of its own -- the same pattern settlement, commercial-terms,
 * and marketplace already use.
 */
export {
  marketStatHygienePolicy,
  type MarketStatHygienePolicyValue,
} from "./features/market-trades/domain/stat-hygiene-policy";
export {
  marketAnalyticsDisplayPolicy,
  type MarketAnalyticsDisplayPolicyValue,
} from "./features/market-rollups/domain/display-policy";
export type { ProductMarketStatsSnapshotResponse } from "./features/market-rollups/api/runtime";
