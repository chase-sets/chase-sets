import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  runDailyRollupCloser,
  type DailyRollupCloserParams,
  type DailyRollupCloserResult,
} from "../read-model/rollup-maintenance";
import {
  getMarketStateSnapshotSeries,
  getProductMarketAggregate,
  getProductMarketStatsSnapshot,
  getProductRollupSeries,
  type GetMarketStateSnapshotSeriesParams,
  type GetProductRollupSeriesParams,
  type MarketStateSnapshotPoint,
  type ProductMarketAggregate,
  type ProductMarketStatsSnapshot,
  type ProductRollupSeriesPoint,
} from "../read-model/queries";
import {
  getPlatformGmvForMonth,
  getPlatformGmvSeries,
  getPlatformKpiSummary,
  getPlatformLiquiditySummary,
  getTopCatalogItemsByGmv,
  type GetPlatformGmvSeriesParams,
  type PlatformGmvSeriesPoint,
  type PlatformKpiSummary,
  type PlatformLiquiditySummary,
  type TopCatalogItemGmv,
} from "../read-model/platform-queries";

type MarketRollupsRuntimeDeps = Readonly<{
  db: PgQueryable;
}>;

export type MarketRollupsServices = Readonly<{
  /** Scheduled worker entry point (deployables/platform-worker) -- see rollup-maintenance.ts for why this is a job, not a projection. */
  runDailyRollupCloser: (params?: DailyRollupCloserParams) => Promise<DailyRollupCloserResult>;
  getProductRollupSeries: (params: GetProductRollupSeriesParams) => Promise<readonly ProductRollupSeriesPoint[]>;
  getMarketStateSnapshotSeries: (
    params: GetMarketStateSnapshotSeriesParams,
  ) => Promise<readonly MarketStateSnapshotPoint[]>;
  getProductMarketAggregate: (
    params: Readonly<{ catalogItemId: string; productId: string }>,
  ) => Promise<ProductMarketAggregate | null>;
  getProductMarketStatsSnapshot: (
    params: Readonly<{ catalogItemId: string; productId: string }>,
  ) => Promise<ProductMarketStatsSnapshot>;
  /** Platform-wide GMV/volume time series, consumed cross-context by platform-operations' ops dashboard. */
  getPlatformGmvSeries: (params: GetPlatformGmvSeriesParams) => Promise<readonly PlatformGmvSeriesPoint[]>;
  getPlatformGmvForMonth: (params: Readonly<{ yearMonth: string }>) => Promise<string>;
  getPlatformKpiSummary: (params: Readonly<{ from: string; to: string }>) => Promise<PlatformKpiSummary>;
  getPlatformLiquiditySummary: (params: Readonly<{ asOfDay: string }>) => Promise<PlatformLiquiditySummary>;
  getTopCatalogItemsByGmv: (
    params: Readonly<{ from: string; to: string; limit?: number }>,
  ) => Promise<readonly TopCatalogItemGmv[]>;
}>;

export function createMarketRollupsRuntime(deps: MarketRollupsRuntimeDeps): MarketRollupsServices {
  return {
    runDailyRollupCloser: (params) => runDailyRollupCloser(deps.db, params),
    getProductRollupSeries: (params) => getProductRollupSeries(deps.db, params),
    getMarketStateSnapshotSeries: (params) => getMarketStateSnapshotSeries(deps.db, params),
    getProductMarketAggregate: (params) => getProductMarketAggregate(deps.db, params),
    getProductMarketStatsSnapshot: (params) => getProductMarketStatsSnapshot(deps.db, params),
    getPlatformGmvSeries: (params) => getPlatformGmvSeries(deps.db, params),
    getPlatformGmvForMonth: (params) => getPlatformGmvForMonth(deps.db, params),
    getPlatformKpiSummary: (params) => getPlatformKpiSummary(deps.db, params),
    getPlatformLiquiditySummary: (params) => getPlatformLiquiditySummary(deps.db, params),
    getTopCatalogItemsByGmv: (params) => getTopCatalogItemsByGmv(deps.db, params),
  };
}
