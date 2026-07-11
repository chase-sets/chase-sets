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
}>;

export function createMarketRollupsRuntime(deps: MarketRollupsRuntimeDeps): MarketRollupsServices {
  return {
    runDailyRollupCloser: (params) => runDailyRollupCloser(deps.db, params),
    getProductRollupSeries: (params) => getProductRollupSeries(deps.db, params),
    getMarketStateSnapshotSeries: (params) => getMarketStateSnapshotSeries(deps.db, params),
    getProductMarketAggregate: (params) => getProductMarketAggregate(deps.db, params),
    getProductMarketStatsSnapshot: (params) => getProductMarketStatsSnapshot(deps.db, params),
  };
}
