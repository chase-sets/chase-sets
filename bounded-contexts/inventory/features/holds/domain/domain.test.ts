import { describe, expect, it } from "vitest";
import { decideInventoryHold, evolveInventoryHold, initialInventoryHoldState } from "./domain";

describe("inventory holds", () => {
  it("places and releases active holds", () => {
    const [placed] = decideInventoryHold(initialInventoryHoldState, {
      type: "PlaceInventoryHold",
      holdId: "hold_1" as never,
      accountId: "acc_1" as never,
      itemId: " inv_1 ",
      quantity: 2,
      reason: " Manual hold ",
      notes: " Buyer order ",
      purpose: "manual",
      sourceRef: null,
      expiresAt: null,
    });
    const placedState = evolveInventoryHold(initialInventoryHoldState, placed!);
    const [released] = decideInventoryHold(placedState, {
      type: "ReleaseInventoryHold",
      releasedAt: "2026-04-30T00:00:00.000Z",
      releaseReason: "manual",
    });

    expect(placedState).toMatchObject({
      itemId: "inv_1",
      reason: "Manual hold",
      notes: "Buyer order",
      purpose: "manual",
      sourceRef: null,
      expiresAt: null,
      status: "active",
    });
    expect(evolveInventoryHold(placedState, released!)).toMatchObject({
      status: "released",
      releasedAt: "2026-04-30T00:00:00.000Z",
      releaseReason: "manual",
    });
  });

  it("places order holds with source references and expiry round-trip", () => {
    const [placed] = decideInventoryHold(initialInventoryHoldState, {
      type: "PlaceInventoryHold",
      holdId: "hold_1" as never,
      accountId: "acc_1" as never,
      itemId: "inv_1",
      quantity: 1,
      reason: "Ordering commitment",
      notes: null,
      purpose: "order",
      sourceRef: {
        orderId: " ord_1 ",
        reservationRequestId: " rsv_1 ",
      },
      expiresAt: null,
    });

    expect(placed?.data).toMatchObject({
      purpose: "order",
      sourceRef: {
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      },
      expiresAt: null,
    });
    expect(evolveInventoryHold(initialInventoryHoldState, placed!)).toMatchObject({
      purpose: "order",
      sourceRef: {
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      },
      expiresAt: null,
    });
  });

  it("rejects invalid purpose source reference and release reason combinations", () => {
    expect(() =>
      decideInventoryHold(initialInventoryHoldState, {
        type: "PlaceInventoryHold",
        holdId: "hold_1" as never,
        accountId: "acc_1" as never,
        itemId: "inv_1",
        quantity: 1,
        reason: "Checkout",
        notes: null,
        purpose: "checkout",
        sourceRef: null,
        expiresAt: "2026-04-30T00:00:00.000Z",
      }),
    ).toThrow("Inventory hold purpose checkout is planned but not active yet.");

    expect(() =>
      decideInventoryHold(initialInventoryHoldState, {
        type: "PlaceInventoryHold",
        holdId: "hold_1" as never,
        accountId: "acc_1" as never,
        itemId: "inv_1",
        quantity: 1,
        reason: "Ordering commitment",
        notes: null,
        purpose: "order",
        sourceRef: null,
        expiresAt: null,
      }),
    ).toThrow("Order inventory holds require a source reference.");

    const [placed] = decideInventoryHold(initialInventoryHoldState, {
      type: "PlaceInventoryHold",
      holdId: "hold_1" as never,
      accountId: "acc_1" as never,
      itemId: "inv_1",
      quantity: 1,
      reason: "Manual hold",
      notes: null,
      purpose: "manual",
      sourceRef: null,
      expiresAt: null,
    });

    expect(() =>
      decideInventoryHold(evolveInventoryHold(initialInventoryHoldState, placed!), {
        type: "ReleaseInventoryHold",
        releasedAt: "2026-04-30T00:00:00.000Z",
        releaseReason: "invalid" as never,
      }),
    ).toThrow("Unsupported inventory hold release reason: invalid.");
  });

  it("rejects invalid release transitions", () => {
    expect(() =>
      decideInventoryHold(initialInventoryHoldState, {
        type: "ReleaseInventoryHold",
        releasedAt: "2026-04-30T00:00:00.000Z",
        releaseReason: "manual",
      }),
    ).toThrow("Inventory hold must be created first.");
  });
});
