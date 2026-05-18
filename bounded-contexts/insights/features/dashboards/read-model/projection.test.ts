import { describe, expect, it } from "vitest";
import { projectDashboardKpis } from "./projection";

describe("insights dashboard projection", () => {
  it("projects account-scoped seller, fulfillment, and conversion KPIs", () => {
    expect(
      projectDashboardKpis("acc_1", [
        {
          sourceContext: "marketplace",
          eventName: "OfferAccepted",
          accountId: "acc_1",
          listingId: "lst_1",
          occurredAt: "2026-04-30T00:00:00.000Z",
          valueAmount: 20,
        },
        {
          sourceContext: "ordering",
          eventName: "OrderPaid",
          accountId: "acc_1",
          orderId: "ord_1",
          occurredAt: "2026-04-30T01:00:00.000Z",
          orderTotalAmount: 30,
        },
        {
          sourceContext: "marketplace",
          eventName: "ListingViewed",
          accountId: "acc_1",
          listingId: "lst_1",
          occurredAt: "2026-04-30T02:00:00.000Z",
        },
        {
          sourceContext: "ordering",
          eventName: "OrderPlaced",
          accountId: "acc_1",
          orderId: "ord_2",
          occurredAt: "2026-04-30T03:00:00.000Z",
          orderTotalAmount: 10,
        },
        {
          sourceContext: "fulfillment",
          eventName: "ShipmentDelivered",
          accountId: "acc_1",
          orderId: "ord_1",
          occurredAt: "2026-04-30T04:00:00.000Z",
          latencyHours: 24,
        },
        {
          sourceContext: "ordering",
          eventName: "OrderPaid",
          accountId: "acc_other",
          orderId: "ord_3",
          occurredAt: "2026-04-30T05:00:00.000Z",
          orderTotalAmount: 999,
        },
      ]),
    ).toMatchObject({
      salesPerformanceKpi: {
        accountId: "acc_1",
        acceptedOfferCount: 1,
        paidOrderCount: 1,
        grossSalesAmount: 50,
      },
      fulfillmentLatencyKpi: {
        deliveredShipmentCount: 1,
        averageLatencyHours: 24,
      },
      conversionOrderKpi: {
        listingViewCount: 1,
        orderPlacedCount: 1,
        conversionRate: 1,
      },
    });
  });
});
