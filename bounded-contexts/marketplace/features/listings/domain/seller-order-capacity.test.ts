import { describe, expect, it } from "vitest";
import {
  decideSellerOrderCapacity,
  evolveSellerOrderCapacity,
  initialSellerOrderCapacityState,
} from "./seller-order-capacity";

describe("seller order capacity", () => {
  it("defaults to unlimited when no stream exists yet", () => {
    expect(initialSellerOrderCapacityState).toEqual({
      accountId: null,
      maxOpenOrders: null,
    });
  });

  it("sets a seller order capacity cap", () => {
    const events = decideSellerOrderCapacity(initialSellerOrderCapacityState, {
      type: "SetSellerOrderCapacity",
      accountId: "acc_seller",
      maxOpenOrders: 5,
    });

    expect(events).toEqual([
      {
        type: "marketplace.seller-order-capacity.set",
        data: { accountId: "acc_seller", maxOpenOrders: 5 },
      },
    ]);

    const state = events.reduce(evolveSellerOrderCapacity, initialSellerOrderCapacityState);
    expect(state).toEqual({ accountId: "acc_seller", maxOpenOrders: 5 });
  });

  it("rejects a cap below 1", () => {
    expect(() =>
      decideSellerOrderCapacity(initialSellerOrderCapacityState, {
        type: "SetSellerOrderCapacity",
        accountId: "acc_seller",
        maxOpenOrders: 0,
      }),
    ).toThrow("Order capacity must be a whole number of at least 1.");
  });

  it("rejects a non-integer cap", () => {
    expect(() =>
      decideSellerOrderCapacity(initialSellerOrderCapacityState, {
        type: "SetSellerOrderCapacity",
        accountId: "acc_seller",
        maxOpenOrders: 2.5,
      }),
    ).toThrow("Order capacity must be a whole number of at least 1.");
  });

  it("no-ops an idempotent re-set to the same cap", () => {
    const initialEvents = decideSellerOrderCapacity(initialSellerOrderCapacityState, {
      type: "SetSellerOrderCapacity",
      accountId: "acc_seller",
      maxOpenOrders: 5,
    });
    const state = initialEvents.reduce(evolveSellerOrderCapacity, initialSellerOrderCapacityState);

    const repeatEvents = decideSellerOrderCapacity(state, {
      type: "SetSellerOrderCapacity",
      accountId: "acc_seller",
      maxOpenOrders: 5,
    });

    expect(repeatEvents).toEqual([]);
  });

  it("emits a fresh set fact when changing an existing cap", () => {
    const initialEvents = decideSellerOrderCapacity(initialSellerOrderCapacityState, {
      type: "SetSellerOrderCapacity",
      accountId: "acc_seller",
      maxOpenOrders: 5,
    });
    const state = initialEvents.reduce(evolveSellerOrderCapacity, initialSellerOrderCapacityState);

    const changeEvents = decideSellerOrderCapacity(state, {
      type: "SetSellerOrderCapacity",
      accountId: "acc_seller",
      maxOpenOrders: 8,
    });

    expect(changeEvents).toEqual([
      {
        type: "marketplace.seller-order-capacity.set",
        data: { accountId: "acc_seller", maxOpenOrders: 8 },
      },
    ]);
  });

  it("clears an existing cap back to unlimited", () => {
    const initialEvents = decideSellerOrderCapacity(initialSellerOrderCapacityState, {
      type: "SetSellerOrderCapacity",
      accountId: "acc_seller",
      maxOpenOrders: 5,
    });
    const state = initialEvents.reduce(evolveSellerOrderCapacity, initialSellerOrderCapacityState);

    const clearEvents = decideSellerOrderCapacity(state, {
      type: "ClearSellerOrderCapacity",
      accountId: "acc_seller",
    });

    expect(clearEvents).toEqual([
      {
        type: "marketplace.seller-order-capacity.cleared",
        data: { accountId: "acc_seller" },
      },
    ]);

    const clearedState = clearEvents.reduce(evolveSellerOrderCapacity, state);
    expect(clearedState).toEqual({ accountId: "acc_seller", maxOpenOrders: null });
  });

  it("no-ops clearing when already unlimited", () => {
    const events = decideSellerOrderCapacity(initialSellerOrderCapacityState, {
      type: "ClearSellerOrderCapacity",
      accountId: "acc_seller",
    });

    expect(events).toEqual([]);
  });

  it("rejects a blank account id", () => {
    expect(() =>
      decideSellerOrderCapacity(initialSellerOrderCapacityState, {
        type: "SetSellerOrderCapacity",
        accountId: "   ",
        maxOpenOrders: 5,
      }),
    ).toThrow("Account id is required.");
  });
});
