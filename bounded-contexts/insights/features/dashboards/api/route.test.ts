import { describe, expect, it } from "vitest";
import { createDashboardRouteContracts, resolveDashboardRoute } from "./route";
import { createDashboardQueryService } from "../read-model/queries";
import type { DashboardKpiReadModels } from "../read-model/projection";

describe("insights dashboard routes", () => {
  it("resolves dashboard route contracts through the query service", async () => {
    const model: DashboardKpiReadModels = {
      sellerPerformanceKpi: {
        accountId: "acc_1",
        acceptedOfferCount: 2,
        paidOrderCount: 1,
        grossSalesAmount: 42,
      },
      fulfillmentLatencyKpi: {
        accountId: "acc_1",
        deliveredShipmentCount: 1,
        averageLatencyHours: 18,
      },
      conversionOrderKpi: {
        accountId: "acc_1",
        listingViewCount: 10,
        orderPlacedCount: 2,
        conversionRate: 0.2,
      },
    };
    const service = createDashboardQueryService(new Map([["acc_1", model]]));
    const [sellerRoute, fulfillmentRoute, conversionRoute] = createDashboardRouteContracts();

    await expect(resolveDashboardRoute(service, sellerRoute!.path, "acc_1")).resolves.toEqual(
      model.sellerPerformanceKpi,
    );
    await expect(resolveDashboardRoute(service, fulfillmentRoute!.path, "acc_1")).resolves.toEqual(
      model.fulfillmentLatencyKpi,
    );
    await expect(resolveDashboardRoute(service, conversionRoute!.path, "missing")).resolves.toEqual({
      accountId: "missing",
      listingViewCount: 0,
      orderPlacedCount: 0,
      conversionRate: 0,
    });
  });
});
