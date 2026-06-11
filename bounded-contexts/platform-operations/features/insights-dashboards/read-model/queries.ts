import type {
  ConversionOrderKpiReadModel,
  DashboardKpiReadModels,
  FulfillmentLatencyKpiReadModel,
  SalesPerformanceKpiReadModel,
} from "./projection";

export type DashboardQueryParams = Readonly<{
  accountId: string;
}>;

export type InsightsDashboardQueryService = Readonly<{
  getSalesPerformanceKpi(params: DashboardQueryParams): Promise<SalesPerformanceKpiReadModel>;
  getFulfillmentLatencyKpi(params: DashboardQueryParams): Promise<FulfillmentLatencyKpiReadModel>;
  getConversionOrderKpi(params: DashboardQueryParams): Promise<ConversionOrderKpiReadModel>;
}>;

export function createDashboardQueryService(
  readModelByAccountId: ReadonlyMap<string, DashboardKpiReadModels>,
): InsightsDashboardQueryService {
  return {
    async getSalesPerformanceKpi(params) {
      return (
        readModelByAccountId.get(params.accountId)?.salesPerformanceKpi ?? {
          accountId: params.accountId,
          acceptedOfferCount: 0,
          paidOrderCount: 0,
          grossSalesAmount: 0,
        }
      );
    },
    async getFulfillmentLatencyKpi(params) {
      return (
        readModelByAccountId.get(params.accountId)?.fulfillmentLatencyKpi ?? {
          accountId: params.accountId,
          deliveredShipmentCount: 0,
          averageLatencyHours: 0,
        }
      );
    },
    async getConversionOrderKpi(params) {
      return (
        readModelByAccountId.get(params.accountId)?.conversionOrderKpi ?? {
          accountId: params.accountId,
          listingViewCount: 0,
          orderPlacedCount: 0,
          conversionRate: 0,
        }
      );
    },
  };
}
