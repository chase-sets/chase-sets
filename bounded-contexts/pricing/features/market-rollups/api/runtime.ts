import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { marketStatHygienePolicy } from "../../market-trades/domain/stat-hygiene-policy";
import { marketAnalyticsDisplayPolicy } from "../domain/display-policy";
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
  /** Pricing's mounted platform-policy runtime -- resolves the stat-hygiene and display policies. */
  policies: Pick<PolicyRuntime, "resolvePolicy">;
}>;

/**
 * The market-rollups query API's stats response, decorated with the
 * resolved stat-hygiene and display policy fields that shape how consumers
 * (the item-detail market panel, the public market page) present it.
 */
export type ProductMarketStatsSnapshotResponse = ProductMarketStatsSnapshot &
  Readonly<{
    statHygiene: Readonly<{ minimumTradeSample: number }>;
    displayPolicy: Readonly<{ showVerifiedMarkers: boolean }>;
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
  ) => Promise<ProductMarketStatsSnapshotResponse>;
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
  async function resolveStatHygienePolicy() {
    return (await deps.policies.resolvePolicy(marketStatHygienePolicy)).value;
  }
  async function resolveDisplayPolicy() {
    return (await deps.policies.resolvePolicy(marketAnalyticsDisplayPolicy)).value;
  }

  return {
    runDailyRollupCloser: async (params) => runDailyRollupCloser(deps.db, params, await resolveStatHygienePolicy()),
    getProductRollupSeries: async (params) =>
      getProductRollupSeries(deps.db, params, (await resolveStatHygienePolicy()).minimumTradeSample),
    getMarketStateSnapshotSeries: (params) => getMarketStateSnapshotSeries(deps.db, params),
    getProductMarketAggregate: (params) => getProductMarketAggregate(deps.db, params),
    getProductMarketStatsSnapshot: async (params) => {
      const [snapshot, statHygiene, display] = await Promise.all([
        getProductMarketStatsSnapshot(deps.db, params),
        resolveStatHygienePolicy(),
        resolveDisplayPolicy(),
      ]);
      return {
        ...snapshot,
        statHygiene: { minimumTradeSample: statHygiene.minimumTradeSample },
        displayPolicy: { showVerifiedMarkers: display.showVerifiedMarkers },
      };
    },
    getPlatformGmvSeries: (params) => getPlatformGmvSeries(deps.db, params),
    getPlatformGmvForMonth: (params) => getPlatformGmvForMonth(deps.db, params),
    getPlatformKpiSummary: (params) => getPlatformKpiSummary(deps.db, params),
    getPlatformLiquiditySummary: (params) => getPlatformLiquiditySummary(deps.db, params),
    getTopCatalogItemsByGmv: (params) => getTopCatalogItemsByGmv(deps.db, params),
  };
}
