export type InsightsDashboardIntegrationEvent =
  | Readonly<{
      sourceContext: "ordering";
      eventName: "OrderPlaced" | "OrderPaid";
      accountId: string;
      orderId: string;
      occurredAt: string;
      orderTotalAmount: number;
    }>
  | Readonly<{
      sourceContext: "marketplace";
      eventName: "OfferAccepted" | "ListingViewed";
      accountId: string;
      listingId: string;
      occurredAt: string;
      valueAmount?: number;
    }>
  | Readonly<{
      sourceContext: "fulfillment";
      eventName: "ShipmentDelivered";
      accountId: string;
      orderId: string;
      occurredAt: string;
      latencyHours: number;
    }>;

export type SalesPerformanceKpiReadModel = Readonly<{
  accountId: string;
  acceptedOfferCount: number;
  paidOrderCount: number;
  grossSalesAmount: number;
}>;

export type FulfillmentLatencyKpiReadModel = Readonly<{
  accountId: string;
  deliveredShipmentCount: number;
  averageLatencyHours: number;
}>;

export type ConversionOrderKpiReadModel = Readonly<{
  accountId: string;
  listingViewCount: number;
  orderPlacedCount: number;
  conversionRate: number;
}>;

export type DashboardKpiReadModels = Readonly<{
  salesPerformanceKpi: SalesPerformanceKpiReadModel;
  fulfillmentLatencyKpi: FulfillmentLatencyKpiReadModel;
  conversionOrderKpi: ConversionOrderKpiReadModel;
}>;

export function projectDashboardKpis(
  accountId: string,
  events: readonly InsightsDashboardIntegrationEvent[],
): DashboardKpiReadModels {
  let acceptedOfferCount = 0;
  let paidOrderCount = 0;
  let grossSalesAmount = 0;
  let deliveredShipmentCount = 0;
  let totalLatencyHours = 0;
  let listingViewCount = 0;
  let orderPlacedCount = 0;

  for (const event of events) {
    if (event.accountId !== accountId) {
      continue;
    }

    if (event.sourceContext === "marketplace" && event.eventName === "OfferAccepted") {
      acceptedOfferCount += 1;
      grossSalesAmount += event.valueAmount ?? 0;
      continue;
    }

    if (event.sourceContext === "marketplace" && event.eventName === "ListingViewed") {
      listingViewCount += 1;
      continue;
    }

    if (event.sourceContext === "ordering" && event.eventName === "OrderPlaced") {
      orderPlacedCount += 1;
      continue;
    }

    if (event.sourceContext === "ordering" && event.eventName === "OrderPaid") {
      paidOrderCount += 1;
      grossSalesAmount += event.orderTotalAmount;
      continue;
    }

    if (event.sourceContext === "fulfillment" && event.eventName === "ShipmentDelivered") {
      deliveredShipmentCount += 1;
      totalLatencyHours += event.latencyHours;
    }
  }

  const averageLatencyHours =
    deliveredShipmentCount === 0 ? 0 : totalLatencyHours / deliveredShipmentCount;

  const conversionRate =
    listingViewCount === 0 ? 0 : Number((orderPlacedCount / listingViewCount).toFixed(4));

  return {
    salesPerformanceKpi: {
      accountId,
      acceptedOfferCount,
      paidOrderCount,
      grossSalesAmount,
    },
    fulfillmentLatencyKpi: {
      accountId,
      deliveredShipmentCount,
      averageLatencyHours,
    },
    conversionOrderKpi: {
      accountId,
      listingViewCount,
      orderPlacedCount,
      conversionRate,
    },
  };
}
