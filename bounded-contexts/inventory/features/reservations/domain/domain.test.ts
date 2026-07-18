import { describe, expect, it } from "vitest";
import { decideInventoryReservation, evolveInventoryReservation, initialInventoryReservationState } from "./domain";

describe("inventory reservations", () => {
  it("confirms, idempotently repeats, and releases reservations", () => {
    const command = {
      type: "ConfirmInventoryReservation" as const,
      reservationRequestId: " req_1 ",
      orderId: " ord_1 ",
      sellerAccountId: " acc_1 ",
      inventoryItemId: " inv_1 ",
      quantity: 1,
      holdId: " hold_1 ",
    };
    const [confirmed] = decideInventoryReservation(initialInventoryReservationState, command);
    const confirmedState = evolveInventoryReservation(initialInventoryReservationState, confirmed!);
    const [released] = decideInventoryReservation(confirmedState, {
      type: "ReleaseInventoryReservation",
      releasedAt: "2026-04-30T00:00:00.000Z",
      releaseReason: "hold-collision",
    });

    expect(decideInventoryReservation(confirmedState, command)).toEqual([]);
    expect(evolveInventoryReservation(confirmedState, released!)).toMatchObject({
      status: "released",
      releasedAt: "2026-04-30T00:00:00.000Z",
      releaseReason: "hold-collision",
    });
  });

  it("rejects release before confirmation", () => {
    expect(() =>
      decideInventoryReservation(initialInventoryReservationState, {
        type: "ReleaseInventoryReservation",
        releasedAt: "2026-04-30T00:00:00.000Z",
        releaseReason: "order-cancelled",
      }),
    ).toThrow("Only confirmed inventory reservations can be released.");
  });
});
