import { describe, expect, it } from "vitest";
import {
  createSettlementSupportHoldId,
  decideSupportHoldLifecycle,
  evolveSupportHoldLifecycle,
  initialSupportHoldLifecycleState,
  isRefundResolution,
  supportHoldLifecycleStreamId,
  type SupportHoldLifecycleCommand,
  type SupportHoldLifecycleEvent,
  type SupportHoldLifecycleState,
} from "./support-hold-lifecycle";

const OPENED_AT = "2026-05-31T14:00:00.000Z";
const TERMINAL_AT = "2026-06-02T09:00:00.000Z";

function placeCommand(overrides: Partial<SupportHoldLifecycleCommand> = {}): SupportHoldLifecycleCommand {
  return {
    type: "PlaceSupportHold",
    supportRequestId: "sup_01ABC",
    orderId: "ord_1",
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    flowType: "product-damaged",
    occurredAt: OPENED_AT,
    ...overrides,
  } as SupportHoldLifecycleCommand;
}

/** Fold decide→evolve so replay is exercised exactly as the aggregate repository would. */
function apply(
  state: SupportHoldLifecycleState,
  command: SupportHoldLifecycleCommand,
): { state: SupportHoldLifecycleState; events: readonly SupportHoldLifecycleEvent[] } {
  const events = decideSupportHoldLifecycle(state, command);
  const next = events.reduce(evolveSupportHoldLifecycle, state);
  return { state: next, events };
}

describe("support hold lifecycle aggregate", () => {
  it("places a support-safe hold fact when a case opens", () => {
    const { state, events } = apply(initialSupportHoldLifecycleState, placeCommand());
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("settlement.support-hold.placed.v1");
    expect(events[0]!.data).toEqual({
      factSchemaVersion: 1,
      holdId: "hold_01ABC",
      supportRequestId: "sup_01ABC",
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      flowType: "product-damaged",
      occurredAt: OPENED_AT,
    });
    expect(state.phase).toBe("placed");
  });

  it("carries both buyer and seller routing targets and nothing payout-internal", () => {
    const { events } = apply(initialSupportHoldLifecycleState, placeCommand());
    const keys = Object.keys(events[0]!.data).sort();
    // Routing needs a buyer and a seller; redaction forbids provider ids, money, and ledger internals.
    expect(keys).toContain("buyerAccountId");
    expect(keys).toContain("sellerAccountId");
    expect(keys).not.toEqual(expect.arrayContaining(["providerDisputeId", "amount", "ledgerEntryId", "payoutId"]));
    expect(keys).toEqual([
      "buyerAccountId",
      "factSchemaVersion",
      "flowType",
      "holdId",
      "occurredAt",
      "orderId",
      "sellerAccountId",
      "supportRequestId",
    ]);
  });

  it("is idempotent: a redelivered open emits no second placed fact", () => {
    const first = apply(initialSupportHoldLifecycleState, placeCommand());
    const second = apply(first.state, placeCommand());
    expect(second.events).toHaveLength(0);
    expect(second.state.phase).toBe("placed");
  });

  it("releases the hold back to the seller when a case resolves without a refund", () => {
    const placed = apply(initialSupportHoldLifecycleState, placeCommand());
    const { state, events } = apply(placed.state, {
      type: "ResolveSupportHold",
      supportRequestId: "sup_01ABC",
      resolutionType: "seller-not-at-fault",
      occurredAt: TERMINAL_AT,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("settlement.support-hold.released.v1");
    expect(events[0]!.data).toMatchObject({
      holdId: "hold_01ABC",
      sellerAccountId: "acc_seller",
      buyerAccountId: "acc_buyer",
      releaseReason: "support-resolved",
      occurredAt: TERMINAL_AT,
    });
    expect(state.phase).toBe("released");
  });

  it("consumes the hold (never releases) when a refund resolution applies the funds", () => {
    const placed = apply(initialSupportHoldLifecycleState, placeCommand());
    const { state, events } = apply(placed.state, {
      type: "ResolveSupportHold",
      supportRequestId: "sup_01ABC",
      resolutionType: "full-refund",
      occurredAt: TERMINAL_AT,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("settlement.support-hold.consumed.v1");
    expect(events[0]!.data).toMatchObject({ resolutionType: "full-refund", sellerAccountId: "acc_seller" });
    expect(state.phase).toBe("consumed");
  });

  it("does not emit a spurious release when a consumed case later closes", () => {
    let state = apply(initialSupportHoldLifecycleState, placeCommand()).state;
    state = apply(state, {
      type: "ResolveSupportHold",
      supportRequestId: "sup_01ABC",
      resolutionType: "return-for-refund",
      occurredAt: TERMINAL_AT,
    }).state;
    const closed = apply(state, {
      type: "CloseSupportHold",
      supportRequestId: "sup_01ABC",
      occurredAt: "2026-06-03T09:00:00.000Z",
    });
    expect(closed.events).toHaveLength(0);
    expect(closed.state.phase).toBe("consumed");
  });

  it("releases on a direct close with no prior resolution", () => {
    const placed = apply(initialSupportHoldLifecycleState, placeCommand());
    const closed = apply(placed.state, {
      type: "CloseSupportHold",
      supportRequestId: "sup_01ABC",
      occurredAt: TERMINAL_AT,
    });
    expect(closed.events).toHaveLength(1);
    expect(closed.events[0]!.data).toMatchObject({ releaseReason: "support-closed" });
  });

  it("releases on cancellation", () => {
    const placed = apply(initialSupportHoldLifecycleState, placeCommand());
    const cancelled = apply(placed.state, {
      type: "CancelSupportHold",
      supportRequestId: "sup_01ABC",
      occurredAt: TERMINAL_AT,
    });
    expect(cancelled.events).toHaveLength(1);
    expect(cancelled.events[0]!.data).toMatchObject({ releaseReason: "support-cancelled" });
  });

  it("releases at most once: a resolve then close emits only the resolve's release", () => {
    let state = apply(initialSupportHoldLifecycleState, placeCommand()).state;
    const resolved = apply(state, {
      type: "ResolveSupportHold",
      supportRequestId: "sup_01ABC",
      resolutionType: "seller-not-at-fault",
      occurredAt: TERMINAL_AT,
    });
    state = resolved.state;
    const closed = apply(state, {
      type: "CloseSupportHold",
      supportRequestId: "sup_01ABC",
      occurredAt: "2026-06-03T09:00:00.000Z",
    });
    expect(resolved.events).toHaveLength(1);
    expect(closed.events).toHaveLength(0);
  });

  it("is a no-op for a terminal event on a hold that was never placed", () => {
    const cancelled = apply(initialSupportHoldLifecycleState, {
      type: "CancelSupportHold",
      supportRequestId: "sup_01ABC",
      occurredAt: TERMINAL_AT,
    });
    expect(cancelled.events).toHaveLength(0);
    expect(cancelled.state.phase).toBe("unplaced");
  });

  it("classifies refund resolutions and derives stable ids", () => {
    expect(isRefundResolution("partial-refund")).toBe(true);
    expect(isRefundResolution("cancel-order")).toBe(true);
    expect(isRefundResolution("seller-not-at-fault")).toBe(false);
    expect(createSettlementSupportHoldId("sup_01ABC")).toBe("hold_01ABC");
    expect(supportHoldLifecycleStreamId("hold_01ABC")).toBe("settlement.support-hold-lifecycle-hold_01ABC");
  });
});
