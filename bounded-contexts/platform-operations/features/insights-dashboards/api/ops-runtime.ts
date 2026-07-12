import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listGmvReconciliationRuns, runGmvReconciliation, type GmvReconciliationRun } from "../read-model/ops-queries";
import type {
  OpsGmvSeriesPoint,
  OpsGranularity,
  OpsKpiSummary,
  OpsLiquiditySummary,
  OpsMarketAnalyticsCrossContextPort,
  OpsTopCatalogItem,
} from "./ops-contracts";

type OpsDashboardRuntimeDeps = Readonly<{
  db: PgQueryable;
  crossContext?: OpsMarketAnalyticsCrossContextPort;
}>;

export type OpsDashboardServices = Readonly<{
  /** True when pricing's `opsMarketAnalyticsCrossContext` host port is wired (always in `platform-api`; may be absent in isolated/unit test composition). */
  crossContextAvailable: boolean;
  getPlatformGmvSeries: (
    params: Readonly<{ from: string; to: string; granularity?: OpsGranularity }>,
  ) => Promise<readonly OpsGmvSeriesPoint[]>;
  getPlatformKpiSummary: (params: Readonly<{ from: string; to: string }>) => Promise<OpsKpiSummary>;
  getPlatformLiquiditySummary: (params: Readonly<{ asOfDay: string }>) => Promise<OpsLiquiditySummary>;
  getTopCatalogItemsByGmv: (
    params: Readonly<{ from: string; to: string; limit?: number }>,
  ) => Promise<readonly OpsTopCatalogItem[]>;
  /** Records a tape-vs-ledger drift check for one month. Called by the platform-worker scheduled job, which fetches both source amounts itself. */
  recordReconciliationRun: (
    params: Readonly<{ yearMonth: string; tapeGmvAmount: string; ledgerSaleAmount: string; now?: string }>,
  ) => Promise<GmvReconciliationRun>;
  listReconciliationRuns: (params?: Readonly<{ limit?: number }>) => Promise<readonly GmvReconciliationRun[]>;
}>;

const EMPTY_KPI_SUMMARY: OpsKpiSummary = {
  gmvAmount: "0.00",
  tradeCount: 0,
  orderCount: 0,
  unitVolume: 0,
  verifiedTradeCount: 0,
  activeBuyerCount: 0,
  activeSellerCount: 0,
};

function requireCrossContext(
  crossContext: OpsMarketAnalyticsCrossContextPort | undefined,
): OpsMarketAnalyticsCrossContextPort {
  if (!crossContext) {
    throw new Error(
      "The ops dashboard's pricing/settlement cross-context read port is unavailable in this composition.",
    );
  }
  return crossContext;
}

export function createOpsDashboardRuntime(deps: OpsDashboardRuntimeDeps): OpsDashboardServices {
  return {
    crossContextAvailable: Boolean(deps.crossContext),
    getPlatformGmvSeries: (params) => requireCrossContext(deps.crossContext).getPlatformGmvSeries(params),
    getPlatformKpiSummary: async (params) => {
      if (!deps.crossContext) {
        return EMPTY_KPI_SUMMARY;
      }
      return deps.crossContext.getPlatformKpiSummary(params);
    },
    getPlatformLiquiditySummary: (params) => requireCrossContext(deps.crossContext).getPlatformLiquiditySummary(params),
    getTopCatalogItemsByGmv: async (params) => {
      if (!deps.crossContext) {
        return [];
      }
      return deps.crossContext.getTopCatalogItemsByGmv(params);
    },
    recordReconciliationRun: (params) => runGmvReconciliation(deps.db, params),
    listReconciliationRuns: (params) => listGmvReconciliationRuns(deps.db, params),
  };
}
