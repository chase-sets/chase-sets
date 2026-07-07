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
    ).toThrow("Checkout inventory holds require a source reference.");

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

  it("converts checkout holds to order holds without releasing stock", () => {
    const placedState = checkoutHoldState();
    const [converted] = decideInventoryHold(placedState, {
      type: "ConvertInventoryHold",
      convertedAt: "2026-04-29T00:05:00.000Z",
      orderId: " ord_1 ",
      reservationRequestId: " rsv_1 ",
    });

    expect(converted).toMatchObject({
      type: "inventory.hold.converted",
      data: {
        holdId: "hold_checkout",
        purpose: "order",
        sourceRef: {
          orderId: "ord_1",
          reservationRequestId: "rsv_1",
        },
        expiresAt: null,
      },
    });
    expect(evolveInventoryHold(placedState, converted!)).toMatchObject({
      status: "active",
      purpose: "order",
      sourceRef: {
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      },
      expiresAt: null,
      releasedAt: null,
      releaseReason: null,
    });
  });

  it("expires checkout holds only after their expiry time", () => {
    const placedState = checkoutHoldState();

    expect(() =>
      decideInventoryHold(placedState, {
        type: "ExpireInventoryHold",
        expiredAt: "2026-04-29T00:14:59.000Z",
      }),
    ).toThrow("Checkout inventory holds cannot expire before their expiry time.");

    const [expired] = decideInventoryHold(placedState, {
      type: "ExpireInventoryHold",
      expiredAt: "2026-04-29T00:15:00.000Z",
    });

    expect(expired).toMatchObject({
      type: "inventory.hold.expired",
      data: {
        holdId: "hold_checkout",
        expiredAt: "2026-04-29T00:15:00.000Z",
      },
    });
    expect(evolveInventoryHold(placedState, expired!)).toMatchObject({
      status: "expired",
      expiredAt: "2026-04-29T00:15:00.000Z",
      releasedAt: "2026-04-29T00:15:00.000Z",
      releaseReason: "checkout-expired",
    });
  });

  it("extends checkout holds up to the configured cap", () => {
    const placedState = checkoutHoldState();
    const [firstExtension] = decideInventoryHold(placedState, {
      type: "ExtendInventoryHold",
      extendedAt: "2026-04-29T00:05:00.000Z",
      expiresAt: "2026-04-29T00:20:00.000Z",
      maxExtensionCount: 1,
    });
    const extendedState = evolveInventoryHold(placedState, firstExtension!);

    expect(firstExtension).toMatchObject({
      type: "inventory.hold.extended",
      data: {
        holdId: "hold_checkout",
        expiresAt: "2026-04-29T00:20:00.000Z",
        extensionCount: 1,
      },
    });
    expect(extendedState).toMatchObject({
      expiresAt: "2026-04-29T00:20:00.000Z",
      extensionCount: 1,
    });
    expect(() =>
      decideInventoryHold(extendedState, {
        type: "ExtendInventoryHold",
        extendedAt: "2026-04-29T00:10:00.000Z",
        expiresAt: "2026-04-29T00:25:00.000Z",
        maxExtensionCount: 1,
      }),
    ).toThrow("Checkout reservation extension limit reached.");
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

function checkoutHoldState() {
  const [placed] = decideInventoryHold(initialInventoryHoldState, {
    type: "PlaceInventoryHold",
    holdId: "hold_checkout" as never,
    accountId: "acc_1" as never,
    itemId: "inv_1",
    quantity: 1,
    reason: "Checkout reservation",
    notes: null,
    purpose: "checkout",
    sourceRef: {
      checkoutSessionId: "chk_1" as never,
      lineKey: "cli_1",
    },
    expiresAt: "2026-04-29T00:15:00.000Z",
  });

  return evolveInventoryHold(initialInventoryHoldState, placed!);
}
