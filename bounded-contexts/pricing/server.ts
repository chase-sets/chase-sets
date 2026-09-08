export { getAccountRecommendation, listAccountRecommendations } from "./features/recommendations/read-model/queries";
export { createPricingRequestApiClient } from "./support/request-support/api-client";
export type { PricingHostPorts, PricingServices } from "./support/runtime-support/services";
export type {
  TcgplayerMarketTransport,
  TcgplayerMarketTransportCapability,
} from "./features/price-signals/integrations/tcgplayer/transport-port";
export type {
  TcgplayerMarketCaptureReceiptSink,
  TcgplayerMarketCaptureReceiptSinkCapability,
  TcgplayerMarketCaptureReceiptStorage,
  TcgplayerMarketCaptureReceiptV1,
} from "./features/price-signals/integrations/tcgplayer/capture-sanitizer";
export { createObjectStorageTcgplayerMarketCaptureReceiptSink } from "./features/price-signals/integrations/tcgplayer/capture-sanitizer";
export type { PricingRecommendationServices } from "./features/recommendations/api/runtime";
export type { RepricingEngineServices } from "./features/repricing-engine/api/runtime";
export type { BulkRepriceIngestionServices } from "./features/bulk-reprice-ingestion/api/runtime";
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
export {
  marketEstimatePolicy,
  type MarketEstimatePolicyValue,
} from "./features/market-estimates/domain/estimate-policy";
export { repricingEnginePolicy, type RepricingEnginePolicyValue } from "./features/repricing-engine/domain/policy";
export { priceSignalPolicy, type PriceSignalPolicyValue } from "./features/price-signals/domain/price-signal-policy";
export {
  providerObservationPolicy,
  type ProviderObservationPolicyValue,
} from "./features/price-signals/domain/provider-observation-policy";
export { effectiveSaleAmount, effectiveSaleAmountExact } from "./features/price-signals/domain/effective-sale-price";
export {
  listProviderSaleEvidence,
  listProviderWeeklySaleBuckets,
  listProviderListingSnapshots,
  listProviderListingAskDepth,
  countProviderCompetingSellersAt,
  listProviderListingAskGroups,
  latestProviderMarketCapture,
} from "./features/price-signals/read-model/provider-observation-queries";
export type { ProductMarketStatsSnapshotResponse } from "./features/market-rollups/api/runtime";
