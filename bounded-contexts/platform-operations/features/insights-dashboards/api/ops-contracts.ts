/**
 * Cross-context read shapes for the platform-wide ops dashboard.
 * These mirror pricing's own exported types (`@chase-sets/pricing/server`)
 * structurally rather than importing them, the same way every other
 * cross-context port in this bounded context avoids a direct dependency on
 * the source context's package (see `allowedContextDependencies: []` in
 * context.json) -- the `opsMarketAnalyticsCrossContext` host port is
 * assembled in the platform-api composition root, which DOES import pricing
 * and settlement directly, and hands platform-operations only these
 * function-shaped ports.
 */

export type OpsGranularity = "daily" | "weekly" | "monthly";

export type OpsGmvSeriesPoint = Readonly<{
  day: string;
  gmvAmount: string;
  tradeCount: number;
  unitVolume: number;
  orderCount: number;
  verifiedTradeCount: number;
}>;

export type OpsKpiSummary = Readonly<{
  gmvAmount: string;
  tradeCount: number;
  orderCount: number;
  unitVolume: number;
  verifiedTradeCount: number;
  activeBuyerCount: number;
  activeSellerCount: number;
}>;

export type OpsLiquiditySummary = Readonly<{
  asOfDay: string;
  sellThroughRate: string | null;
  medianSpreadAmount: string | null;
  spreadSampleCount: number;
}>;

export type OpsTopCatalogItem = Readonly<{
  catalogItemId: string;
  title: string | null;
  gmvAmount: string;
  tradeCount: number;
  unitVolume: number;
}>;

export type OpsRepricingSourceShareWeek = Readonly<{
  weekStart: string;
  status: "complete" | "incomplete";
  reason: "checkpoint-lag" | "unattributed-event" | null;
  eventCount: number;
  counts: Readonly<{ bulk: number; policy: number; manual: number; unattributed: number }>;
  shares: Readonly<{ bulk: number; policy: number; manual: number }>;
  topSellers: readonly Readonly<{ accountId: string; bulkShare: number; bulkListingCount: number }>[];
}>;

export type OpsRepricingSourceShare = Readonly<{
  status: "available" | "unavailable";
  weeks: readonly OpsRepricingSourceShareWeek[];
  reason?: string;
}>;

export type OpsMarketAnalyticsCrossContextPort = Readonly<{
  getPlatformGmvSeries: (
    params: Readonly<{ from: string; to: string; granularity?: OpsGranularity }>,
  ) => Promise<readonly OpsGmvSeriesPoint[]>;
  getPlatformKpiSummary: (params: Readonly<{ from: string; to: string }>) => Promise<OpsKpiSummary>;
  getPlatformLiquiditySummary: (params: Readonly<{ asOfDay: string }>) => Promise<OpsLiquiditySummary>;
  getTopCatalogItemsByGmv: (
    params: Readonly<{ from: string; to: string; limit?: number }>,
  ) => Promise<readonly OpsTopCatalogItem[]>;
  getRepricingSourceShare: (params: Readonly<{ from: string; to: string }>) => Promise<OpsRepricingSourceShare>;
}>;
