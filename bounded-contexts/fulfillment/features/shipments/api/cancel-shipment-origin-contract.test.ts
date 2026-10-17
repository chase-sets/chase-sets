import { describe, expect, it } from "vitest";
import type { FulfillmentShipmentServices } from "./runtime";

type CancelForOrder = FulfillmentShipmentServices["cancelShipmentForCancelledOrder"];
declare const cancelForOrder: CancelForOrder;

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_buyer" as never },
};
const sourceIdentity = {
  eventId: "evt_cancel",
  streamId: "ordering.order-ord_race",
  streamVersion: 2,
  eventType: "ordering.order.cancelled",
};

if (false) {
  void cancelForOrder({
    orderId: "ord_race",
    cancelledAt: "2026-08-02T12:00:00.000Z",
    reason: "buyer-cancelled",
    origin: "order-cancelled",
    context,
    sourceIdentity,
  });
  void cancelForOrder({
    orderId: "ord_race",
    cancelledAt: "2026-08-02T12:00:00.000Z",
    reason: null,
    origin: "payment-fraud-warning",
    context,
    sourceIdentity,
  });
  // @ts-expect-error origin is required so every producer identifies its authority.
  void cancelForOrder({
    orderId: "ord_race",
    cancelledAt: "2026-08-02T12:00:00.000Z",
    reason: null,
    context,
    sourceIdentity,
  });
}

describe("cancelShipmentForCancelledOrder origin contract", () => {
  it("keeps the compile-negative fixture enrolled as a runtime suite", () => {
    expect(["order-cancelled", "payment-fraud-warning"]).toHaveLength(2);
  });
});
