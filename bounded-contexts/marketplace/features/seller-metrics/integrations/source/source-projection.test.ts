import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import {
  buildSellerMetricsOrderSourceProjectionHandlers,
  buildSellerMetricsShipmentSourceProjectionHandlers,
  buildSellerMetricsSupportSourceProjectionHandlers,
} from "./source-projection";

class SellerMetricsSourceProjectionDb implements PgQueryable {
  public readonly orders = new Map<
    string,
    { seller_account_id: string; cancellation_reason: string | null; ready_for_fulfillment_at: string | null }
  >();
  public readonly shipments = new Map<
    string,
    { order_id: string; seller_account_id: string; dispatched_at: string | null }
  >();
  public readonly supportRequests = new Map<
    string,
    { order_id: string; seller_account_id: string; resolution_type: string | null; flow_type: string | null }
  >();
  public refreshCalls: Array<{ sellerAccountId: string; now: string }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO marketplace_seller_metrics_order_sources")) {
      this.orders.set(String(values[0]), {
        seller_account_id: String(values[1]),
        cancellation_reason: null,
        ready_for_fulfillment_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE marketplace_seller_metrics_order_sources") && sql.includes("ready_for_fulfillment_at")) {
      const order = this.orders.get(String(values[0]));
      if (!order) return { rows: [], rowCount: 0 };
      order.ready_for_fulfillment_at = String(values[1]);
      return { rows: [{ seller_account_id: order.seller_account_id } as Row], rowCount: 1 };
    }
    if (sql.includes("UPDATE marketplace_seller_metrics_order_sources") && sql.includes("cancellation_reason")) {
      const order = this.orders.get(String(values[0]));
      if (!order) return { rows: [], rowCount: 0 };
      order.cancellation_reason = String(values[2]);
      return { rows: [{ seller_account_id: order.seller_account_id } as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO marketplace_seller_metrics_shipment_sources")) {
      this.shipments.set(String(values[0]), {
        order_id: String(values[1]),
        seller_account_id: String(values[2]),
        dispatched_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE marketplace_seller_metrics_shipment_sources")) {
      const shipment = this.shipments.get(String(values[0]));
      if (!shipment) return { rows: [], rowCount: 0 };
      shipment.dispatched_at = String(values[1]);
      return { rows: [{ seller_account_id: shipment.seller_account_id } as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO marketplace_seller_metrics_support_request_sources")) {
      this.supportRequests.set(String(values[0]), {
        order_id: String(values[1]),
        seller_account_id: String(values[2]),
        resolution_type: String(values[3]),
        flow_type: values[4] === null ? null : String(values[4]),
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query in fake db: ${sql}`);
  }
}

vi.mock("../../read-model/projection", () => ({
  refreshSellerBehavioralMetrics: vi.fn(async () => {}),
}));

describe("marketplace seller-metrics source projection", () => {
  it("records order-created rows keyed by seller and triggers a recompute", async () => {
    const db = new SellerMetricsSourceProjectionDb();
    const handlers = buildSellerMetricsOrderSourceProjectionHandlers(db);

    await handlers["ordering.order.created"]?.({
      streamId: "ordering.order-ord_1",
      type: "ordering.order.created",
      data: { orderId: "ord_1", sellerAccountId: "acc_seller" },
      timing: { recordedAt: "2026-07-01T00:00:00.000Z", occurredAt: "2026-07-01T00:00:00.000Z" },
    } as never);

    expect(db.orders.get("ord_1")?.seller_account_id).toBe("acc_seller");
    const { refreshSellerBehavioralMetrics } = await import("../../read-model/projection");
    expect(refreshSellerBehavioralMetrics).toHaveBeenCalledWith(
      db,
      "acc_seller",
      "2026-07-01T00:00:00.000Z",
      undefined,
    );
  });

  it("records the ready-for-fulfillment timestamp on the existing order row", async () => {
    const db = new SellerMetricsSourceProjectionDb();
    db.orders.set("ord_1", {
      seller_account_id: "acc_seller",
      cancellation_reason: null,
      ready_for_fulfillment_at: null,
    });
    const handlers = buildSellerMetricsOrderSourceProjectionHandlers(db);

    await handlers["ordering.order.ready-for-fulfillment-recorded"]?.({
      streamId: "ordering.order-ord_1",
      type: "ordering.order.ready-for-fulfillment-recorded",
      data: { orderId: "ord_1", readyForFulfillmentAt: "2026-07-02T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-02T00:00:00.000Z", occurredAt: "2026-07-02T00:00:00.000Z" },
    } as never);

    expect(db.orders.get("ord_1")?.ready_for_fulfillment_at).toBe("2026-07-02T00:00:00.000Z");
  });

  it("records the cancellation reason verbatim (seller-metrics attribution reads this literal value)", async () => {
    const db = new SellerMetricsSourceProjectionDb();
    db.orders.set("ord_1", {
      seller_account_id: "acc_seller",
      cancellation_reason: null,
      ready_for_fulfillment_at: null,
    });
    const handlers = buildSellerMetricsOrderSourceProjectionHandlers(db);

    await handlers["ordering.order.cancelled"]?.({
      streamId: "ordering.order-ord_1",
      type: "ordering.order.cancelled",
      data: { orderId: "ord_1", cancelledAt: "2026-07-03T00:00:00.000Z", reason: "seller-cancelled" },
      timing: { recordedAt: "2026-07-03T00:00:00.000Z", occurredAt: "2026-07-03T00:00:00.000Z" },
    } as never);

    expect(db.orders.get("ord_1")?.cancellation_reason).toBe("seller-cancelled");
  });

  it("records shipment creation with the seller account carried on the event, then dispatch", async () => {
    const db = new SellerMetricsSourceProjectionDb();
    const handlers = buildSellerMetricsShipmentSourceProjectionHandlers(db);

    await handlers["fulfillment.shipment.created"]?.({
      streamId: "fulfillment.shipment-ship_1",
      type: "fulfillment.shipment.created",
      data: {
        shipmentId: "ship_1",
        orderId: "ord_1",
        sellerAccountId: "acc_seller",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      timing: { recordedAt: "2026-07-01T00:00:00.000Z", occurredAt: "2026-07-01T00:00:00.000Z" },
    } as never);
    expect(db.shipments.get("ship_1")?.seller_account_id).toBe("acc_seller");

    await handlers["fulfillment.shipment.dispatched"]?.({
      streamId: "fulfillment.shipment-ship_1",
      type: "fulfillment.shipment.dispatched",
      data: { shipmentId: "ship_1", dispatchedAt: "2026-07-02T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-02T00:00:00.000Z", occurredAt: "2026-07-02T00:00:00.000Z" },
    } as never);
    expect(db.shipments.get("ship_1")?.dispatched_at).toBe("2026-07-02T00:00:00.000Z");
  });

  it("records a resolved support request with resolution and flow type", async () => {
    const db = new SellerMetricsSourceProjectionDb();
    const handlers = buildSellerMetricsSupportSourceProjectionHandlers(db);

    await handlers["support.support-request.resolved"]?.({
      streamId: "support.support-request-sr_1",
      type: "support.support-request.resolved",
      data: {
        supportRequestId: "sr_1",
        orderId: "ord_1",
        sellerAccountId: "acc_seller",
        flowType: "seller-cannot-fulfill",
        resolution: { resolutionType: "cancel-order", resolvedAt: "2026-07-04T00:00:00.000Z" },
      },
      timing: { recordedAt: "2026-07-04T00:00:00.000Z", occurredAt: "2026-07-04T00:00:00.000Z" },
    } as never);

    const row = db.supportRequests.get("sr_1");
    expect(row?.resolution_type).toBe("cancel-order");
    expect(row?.flow_type).toBe("seller-cannot-fulfill");
  });
});
