import type { InsightsDashboardQueryService } from "../read-model/queries";
import { insightsDashboardRoutes } from "../ui/contracts";

export type DashboardRouteContract = Readonly<{
  path: string;
  queryContractName: string;
}>;

export function createDashboardRouteContracts(): readonly DashboardRouteContract[] {
  return [
    {
      path: insightsDashboardRoutes.sellerPerformanceKpi,
      queryContractName: "getSellerPerformanceKpi",
    },
    {
      path: insightsDashboardRoutes.fulfillmentLatencyKpi,
      queryContractName: "getFulfillmentLatencyKpi",
    },
    {
      path: insightsDashboardRoutes.conversionOrderKpi,
      queryContractName: "getConversionOrderKpi",
    },
  ];
}

export async function resolveDashboardRoute(
  queryService: InsightsDashboardQueryService,
  routePath: string,
  accountId: string,
) {
  if (routePath === insightsDashboardRoutes.sellerPerformanceKpi) {
    return queryService.getSellerPerformanceKpi({ accountId });
  }

  if (routePath === insightsDashboardRoutes.fulfillmentLatencyKpi) {
    return queryService.getFulfillmentLatencyKpi({ accountId });
  }

  if (routePath === insightsDashboardRoutes.conversionOrderKpi) {
    return queryService.getConversionOrderKpi({ accountId });
  }

  throw new Error(`Unsupported insights dashboard route: ${routePath}`);
}
