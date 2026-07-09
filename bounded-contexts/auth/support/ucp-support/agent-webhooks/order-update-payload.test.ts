import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapOrderLifecycleEventToOrderUpdate } from "./order-update-payload";

function event(type: string, data: Record<string, unknown>, id = "evt_1"): TransportEvent {
  return {
    id,
    type,
    streamId: "stream_1",
    streamVersion: 1,
    globalPosition: "1",
    tenantId: "tenant_1",
    data,
    metadata: {},
    audit: { performedByUserId: "usr_1", forAccountId: "acc_actor" },
    trace: { traceId: "trace_1" },
    timing: { occurredAt: "2026-07-08T00:00:00.000Z", recordedAt: "2026-07-08T00:00:00.000Z" },
  } as unknown as TransportEvent;
}

describe("order lifecycle → UCP order-update mapping", () => {
  it("maps order.created and carries the buyer account", () => {
    const mapped = mapOrderLifecycleEventToOrderUpdate(
      event("ordering.order.created", { orderId: "ord_1", buyerAccountId: "acc_buyer", totalAmount: "42.00" }),
    );
    expect(mapped?.status).toBe("created");
    expect(mapped?.orderIds).toEqual(["ord_1"]);
    expect(mapped?.recipientAccountId).toBe("acc_buyer");
    const payload = mapped?.buildPayload("ord_1");
    expect(payload?.order).toEqual({ id: "ord_1", status: "created" });
    expect(payload?.type).toBe("order.updated");
    expect(payload?.sourceEventId).toBe("evt_1");
    expect(payload?.data.totalAmount).toBe("42.00");
  });

  it("maps shipment.dispatched to shipped only when the order is resolved", () => {
    const dispatched = event("fulfillment.shipment.dispatched", { shipmentId: "shp_1" });
    expect(mapOrderLifecycleEventToOrderUpdate(dispatched)).toBeNull();
    const mapped = mapOrderLifecycleEventToOrderUpdate(dispatched, { resolvedOrderId: "ord_9" });
    expect(mapped?.status).toBe("shipped");
    expect(mapped?.orderIds).toEqual(["ord_9"]);
    expect(mapped?.recipientAccountId).toBeNull();
    expect(mapped?.buildPayload("ord_9").data.shipmentId).toBe("shp_1");
  });

  it("maps shipment.delivered with its buyer account", () => {
    const mapped = mapOrderLifecycleEventToOrderUpdate(
      event("fulfillment.shipment.delivered", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        trackingIdentifier: "1Z",
      }),
    );
    expect(mapped?.status).toBe("delivered");
    expect(mapped?.recipientAccountId).toBe("acc_buyer");
    expect(mapped?.buildPayload("ord_1").data.trackingIdentifier).toBe("1Z");
  });

  it("maps order.cancelled without a carried account", () => {
    const mapped = mapOrderLifecycleEventToOrderUpdate(
      event("ordering.order.cancelled", { orderId: "ord_1", reason: "inventory-unavailable" }),
    );
    expect(mapped?.status).toBe("cancelled");
    expect(mapped?.recipientAccountId).toBeNull();
    expect(mapped?.buildPayload("ord_1").data.reason).toBe("inventory-unavailable");
  });

  it("fans a refund across every order it touches", () => {
    const mapped = mapOrderLifecycleEventToOrderUpdate(
      event("payments.refund-issued", {
        refundId: "ref_1",
        orderIds: ["ord_1", "ord_2"],
        amount: "10.00",
        currencyCode: "USD",
      }),
    );
    expect(mapped?.status).toBe("refunded");
    expect(mapped?.orderIds).toEqual(["ord_1", "ord_2"]);
    expect(mapped?.buildPayload("ord_2").order.id).toBe("ord_2");
    expect(mapped?.buildPayload("ord_2").data.refundId).toBe("ref_1");
  });

  it("ignores unrelated events and empty order references", () => {
    expect(mapOrderLifecycleEventToOrderUpdate(event("ordering.order.reservation-confirmed", {}))).toBeNull();
    expect(
      mapOrderLifecycleEventToOrderUpdate(event("payments.refund-issued", { refundId: "ref_1", orderIds: [] })),
    ).toBeNull();
  });
});
