import { describe, expect, it } from "vitest";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { applyEvents } from "@chase-sets/event-core";
import {
  decideReviewHold,
  evolveReviewHold,
  initialReviewHoldState,
  isReviewDirectionHeld,
  type ReviewHoldCommand,
  type ReviewHoldState,
} from "./review-hold";

const orderId = "ord_hold" as OrderId;

function decide(state: ReviewHoldState, command: ReviewHoldCommand) {
  const events = decideReviewHold(state, command);
  return { events, state: applyEvents(state, evolveReviewHold, events) };
}

describe("review hold", () => {
  it("keeps concurrent requests held until the last terminal fact", () => {
    const first = decide(initialReviewHoldState, {
      type: "RecordReviewHoldOpened",
      orderId,
      supportRequestId: "srq_first",
      openedAt: "2026-07-01T00:00:00.000Z",
    });
    const second = decide(first.state, {
      type: "RecordReviewHoldOpened",
      orderId,
      supportRequestId: "srq_second",
      openedAt: "2026-07-02T00:00:00.000Z",
    });
    const reduced = decide(second.state, {
      type: "RecordReviewHoldTerminal",
      orderId,
      supportRequestId: "srq_first",
      terminalStatus: "resolved",
      terminalAt: "2026-07-03T00:00:00.000Z",
    });
    const released = decide(reduced.state, {
      type: "RecordReviewHoldTerminal",
      orderId,
      supportRequestId: "srq_second",
      terminalStatus: "cancelled",
      terminalAt: "2026-07-04T00:00:00.000Z",
    });

    expect(first.events[0]?.type).toBe("marketplace.review-hold.placed");
    expect(second.events[0]?.type).toBe("marketplace.review-hold.extended");
    expect(reduced.events[0]).toMatchObject({
      type: "marketplace.review-hold.reduced",
      data: { activeSupportRequestIds: ["srq_second"] },
    });
    expect(released.events[0]).toMatchObject({
      type: "marketplace.review-hold.released",
      data: { activeSupportRequestIds: [], heldDirections: [] },
    });
  });

  it("converges when a terminal fact arrives before its opening fact", () => {
    const terminal = decide(initialReviewHoldState, {
      type: "RecordReviewHoldTerminal",
      orderId,
      supportRequestId: "srq_reordered",
      terminalStatus: "resolved",
      terminalAt: "2026-07-05T00:00:00.000Z",
    });
    const lateOpen = decide(terminal.state, {
      type: "RecordReviewHoldOpened",
      orderId,
      supportRequestId: "srq_reordered",
      openedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(terminal.events[0]?.type).toBe("marketplace.review-hold.terminal-recorded");
    expect(lateOpen.events).toEqual([]);
    expect(isReviewDirectionHeld(lateOpen.state, "buyer-to-seller")).toBe(false);
  });

  it("starts a new hold when the same request reopens after its terminal fact", () => {
    const terminal = decide(initialReviewHoldState, {
      type: "RecordReviewHoldTerminal",
      orderId,
      supportRequestId: "srq_reopened",
      terminalStatus: "cancelled",
      terminalAt: "2026-07-05T00:00:00.000Z",
    });
    const reopened = decide(terminal.state, {
      type: "RecordReviewHoldOpened",
      orderId,
      supportRequestId: "srq_reopened",
      openedAt: "2026-07-06T00:00:00.000Z",
      directions: ["buyer-to-seller"],
    });

    expect(reopened.events[0]).toMatchObject({
      type: "marketplace.review-hold.placed",
      data: { heldDirections: ["buyer-to-seller"] },
    });
    expect(isReviewDirectionHeld(reopened.state, "buyer-to-seller")).toBe(true);
    expect(isReviewDirectionHeld(reopened.state, "seller-to-buyer")).toBe(false);
  });

  it("suppresses duplicate lifecycle delivery", () => {
    const opened = decide(initialReviewHoldState, {
      type: "RecordReviewHoldOpened",
      orderId,
      supportRequestId: "srq_duplicate",
      openedAt: "2026-07-01T00:00:00.000Z",
    });
    const duplicate = decide(opened.state, {
      type: "RecordReviewHoldOpened",
      orderId,
      supportRequestId: "srq_duplicate",
      openedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(duplicate.events).toEqual([]);
  });
});
