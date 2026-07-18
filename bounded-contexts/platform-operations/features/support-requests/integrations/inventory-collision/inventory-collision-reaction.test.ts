import { describe, expect, it, vi } from "vitest";
import { buildInventoryCollisionSupportReactionHandlers } from "./inventory-collision-reaction";

function releasedEvent(releaseReason: "hold-collision" | "order-cancelled") {
  return {
    tenantId: "tnt_test",
    streamId: "inventory.reservation-rsv_1",
    streamVersion: 2,
    id: "evt_release",
    type: "inventory.reservation.released",
    data: {
      orderId: "ord_1",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      sellerAccountId: "acc_seller",
      releasedAt: "2026-07-17T12:00:00.000Z",
      releaseReason,
    },
    audit: { performedByUserId: "usr_manager", forAccountId: "acc_seller" },
    trace: { traceId: "trace_1" },
  } as never;
}

describe("inventory collision support reaction", () => {
  it("routes a collision release into the automated seller-cannot-fulfill case", async () => {
    const openAutomatedSellerCannotFulfillRequest = vi.fn(async () => ({ supportRequestId: "sup_1", version: 4 }));
    const handlers = buildInventoryCollisionSupportReactionHandlers({ openAutomatedSellerCannotFulfillRequest });

    await handlers["inventory.reservation.released"]?.(releasedEvent("hold-collision"));

    expect(openAutomatedSellerCannotFulfillRequest).toHaveBeenCalledWith(
      {
        orderId: "ord_1",
        sellerAccountId: "acc_seller",
        reservationRequestId: "rsv_1",
        holdId: "hld_1",
        releasedAt: "2026-07-17T12:00:00.000Z",
      },
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
  });

  it("ignores reservations released by the normal order-cancellation lifecycle", async () => {
    const openAutomatedSellerCannotFulfillRequest = vi.fn();
    const handlers = buildInventoryCollisionSupportReactionHandlers({ openAutomatedSellerCannotFulfillRequest });

    await handlers["inventory.reservation.released"]?.(releasedEvent("order-cancelled"));

    expect(openAutomatedSellerCannotFulfillRequest).not.toHaveBeenCalled();
  });
});
