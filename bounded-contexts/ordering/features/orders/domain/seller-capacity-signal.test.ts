import { describe, expect, it } from "vitest";
import {
  decideSellerCapacitySignal,
  evolveSellerCapacitySignal,
  initialSellerCapacitySignalState,
} from "./seller-capacity-signal";

describe("seller capacity signal", () => {
  it("defaults to not-at-capacity when no stream exists yet", () => {
    expect(initialSellerCapacitySignalState).toEqual({
      accountId: null,
      atCapacity: false,
    });
  });

  it("emits reached the first time a seller crosses into at-capacity", () => {
    const events = decideSellerCapacitySignal(initialSellerCapacitySignalState, {
      type: "MarkSellerAtCapacity",
      accountId: "acc_seller",
    });

    expect(events).toEqual([
      {
        type: "ordering.seller-capacity.reached",
        data: { accountId: "acc_seller" },
      },
    ]);

    const state = events.reduce(evolveSellerCapacitySignal, initialSellerCapacitySignalState);
    expect(state).toEqual({ accountId: "acc_seller", atCapacity: true });
  });

  it("no-ops a repeat mark while already at capacity (idempotent under concurrent claim churn)", () => {
    const initialEvents = decideSellerCapacitySignal(initialSellerCapacitySignalState, {
      type: "MarkSellerAtCapacity",
      accountId: "acc_seller",
    });
    const state = initialEvents.reduce(evolveSellerCapacitySignal, initialSellerCapacitySignalState);

    const repeatEvents = decideSellerCapacitySignal(state, {
      type: "MarkSellerAtCapacity",
      accountId: "acc_seller",
    });

    expect(repeatEvents).toEqual([]);
  });

  it("clears an at-capacity signal exactly once", () => {
    const initialEvents = decideSellerCapacitySignal(initialSellerCapacitySignalState, {
      type: "MarkSellerAtCapacity",
      accountId: "acc_seller",
    });
    const state = initialEvents.reduce(evolveSellerCapacitySignal, initialSellerCapacitySignalState);

    const clearEvents = decideSellerCapacitySignal(state, {
      type: "ClearSellerAtCapacity",
      accountId: "acc_seller",
    });

    expect(clearEvents).toEqual([
      {
        type: "ordering.seller-capacity.cleared",
        data: { accountId: "acc_seller" },
      },
    ]);

    const clearedState = clearEvents.reduce(evolveSellerCapacitySignal, state);
    expect(clearedState).toEqual({ accountId: "acc_seller", atCapacity: false });
  });

  it("no-ops clearing when never at capacity", () => {
    const events = decideSellerCapacitySignal(initialSellerCapacitySignalState, {
      type: "ClearSellerAtCapacity",
      accountId: "acc_seller",
    });

    expect(events).toEqual([]);
  });

  it("rejects a blank account id", () => {
    expect(() =>
      decideSellerCapacitySignal(initialSellerCapacitySignalState, {
        type: "MarkSellerAtCapacity",
        accountId: "   ",
      }),
    ).toThrow("Account id is required.");
  });
});
