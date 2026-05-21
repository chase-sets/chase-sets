import { describe, expect, it, vi } from "vitest";
import {
  NOTIFICATIONS_FULFILLMENT_PROJECTION,
  NOTIFICATIONS_ORDERING_PROJECTION,
  projectSourceEventToNotification,
} from "./notification-projector";

const baseEvent = {
  id: "evt_1",
  tenantId: "tnt_1",
  streamId: "stream_1",
  streamVersion: 1,
  globalPosition: "10" as never,
  trace: { traceId: "trace_1" },
  audit: {
    performedByUserId: "usr_1",
    forAccountId: "acc_1",
  },
  timing: {
    occurredAt: "2026-05-13T00:00:00.000Z" as never,
    recordedAt: "2026-05-13T00:00:00.000Z" as never,
  },
  metadata: {},
} as const;

describe("notifications source event projector", () => {
  it("turns ordering facts into notification-center deliveries", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "ordering.order.created",
        data: {
          orderId: "ord_1",
          buyerAccountId: "acc_buyer" as never,
          totalAmount: "24.00",
          shippingDestinationSnapshot: { email: "buyer@example.test" },
        },
      },
      NOTIFICATIONS_ORDERING_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "ordering.order.created",
          actionHref: "/account/purchases/ord_1",
          actor: { userId: null, accountId: "acc_buyer" },
        }),
        source: expect.objectContaining({
          projectionName: NOTIFICATIONS_ORDERING_PROJECTION,
        }),
      }),
    );
  });

  it("turns fulfillment facts into notification-center deliveries", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };

    await projectSourceEventToNotification(
      outbox,
      {
        ...baseEvent,
        type: "fulfillment.shipment.delivered",
        data: {
          shipmentId: "shp_1",
          orderId: "ord_1",
          buyerAccountId: "acc_buyer" as never,
          trackingIdentifier: "1Z999",
          shippingDestinationSnapshot: { email: null },
        },
      },
      NOTIFICATIONS_FULFILLMENT_PROJECTION,
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "fulfillment.shipment.delivered",
          actionHref: "/account/shipments/shp_1",
          actor: { userId: null, accountId: "acc_buyer" },
        }),
        source: expect.objectContaining({
          projectionName: NOTIFICATIONS_FULFILLMENT_PROJECTION,
        }),
      }),
    );
  });
});
