import { applyEvents } from "@chase-sets/event-core";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { describe, expect, it } from "vitest";
import {
  decideReviewScoring,
  evolveReviewScoring,
  initialReviewScoringState,
  reviewScoringForAuthorRole,
  type ReviewScoringCommand,
  type ReviewScoringState,
} from "./review-scoring";

const orderId = "ord_scoring" as OrderId;

function decide(state: ReviewScoringState, command: ReviewScoringCommand) {
  const events = decideReviewScoring(state, command);
  return { events, state: applyEvents(state, evolveReviewScoring, events) };
}

describe("review scoring", () => {
  it("projects the directional responsibility matrix with source fact versions", () => {
    const resolved = decide(initialReviewScoringState, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_seller",
      sourceStreamVersion: 4,
      status: "resolved",
      responsibility: "seller",
      resolutionType: "partial-refund",
      lifecycleAt: "2026-07-01T00:00:00.000Z",
    });

    expect(resolved.events).toEqual([
      {
        type: "marketplace.review-scoring.disposition-projected.v1",
        data: expect.objectContaining({
          factSchemaVersion: 1,
          orderId,
          policyVersion: "resolution-aware-v1",
          sourceFactVersions: [{ supportRequestId: "sup_seller", sourceStreamVersion: 4, status: "resolved" }],
          buyerToSeller: { scoringDisposition: "included", reasonCode: "subject-responsible" },
          sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "reviewer-responsible" },
          operationalSignal: null,
        }),
      },
    ]);
    expect(reviewScoringForAuthorRole(resolved.state, "buyer").scoringDisposition).toBe("included");
    expect(reviewScoringForAuthorRole(resolved.state, "seller").scoringDisposition).toBe("context-only");
  });

  it("fails legacy missing and unknown responsibility safe to context-only and records a signal", () => {
    const missing = decide(initialReviewScoringState, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_legacy",
      sourceStreamVersion: 2,
      status: "resolved",
      responsibility: undefined,
      resolutionType: "partial-refund",
      lifecycleAt: "2026-07-01T00:00:00.000Z",
    });
    const unknown = decide(missing.state, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_future",
      sourceStreamVersion: 5,
      status: "resolved",
      responsibility: "future-responsibility",
      resolutionType: "support-reviewed",
      lifecycleAt: "2026-07-02T00:00:00.000Z",
    });

    expect(missing.events[0]).toMatchObject({
      data: {
        buyerToSeller: { scoringDisposition: "context-only", reasonCode: "responsibility-undetermined" },
        sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "responsibility-undetermined" },
        operationalSignal: "responsibility-missing",
      },
    });
    expect(unknown.events[0]).toMatchObject({
      data: {
        buyerToSeller: { scoringDisposition: "context-only", reasonCode: "responsibility-unrecognized" },
        sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "responsibility-unrecognized" },
        operationalSignal: "responsibility-unrecognized",
      },
    });
  });

  it("composes concurrent requests and restores scoring only after the final open request is terminal", () => {
    const firstOpen = decide(initialReviewScoringState, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_first",
      sourceStreamVersion: 1,
      status: "open",
      lifecycleAt: "2026-07-01T00:00:00.000Z",
    });
    const secondOpen = decide(firstOpen.state, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_second",
      sourceStreamVersion: 1,
      status: "open",
      lifecycleAt: "2026-07-02T00:00:00.000Z",
    });
    const firstResolved = decide(secondOpen.state, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_first",
      sourceStreamVersion: 2,
      status: "resolved",
      responsibility: "seller",
      resolutionType: "partial-refund",
      lifecycleAt: "2026-07-03T00:00:00.000Z",
    });
    const lastCancelled = decide(firstResolved.state, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_second",
      sourceStreamVersion: 2,
      status: "cancelled",
      lifecycleAt: "2026-07-04T00:00:00.000Z",
    });

    expect(firstResolved.events[0]).toMatchObject({
      data: {
        buyerToSeller: { scoringDisposition: "context-only", reasonCode: "support-request-open" },
        sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "support-request-open" },
      },
    });
    expect(lastCancelled.events[0]).toMatchObject({
      data: {
        buyerToSeller: { scoringDisposition: "included", reasonCode: "subject-responsible" },
        sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "reviewer-responsible" },
      },
    });
  });

  it("ignores duplicate and reordered source delivery by stream version", () => {
    const resolved = decide(initialReviewScoringState, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_reordered",
      sourceStreamVersion: 3,
      status: "resolved",
      responsibility: "carrier",
      lifecycleAt: "2026-07-03T00:00:00.000Z",
    });
    const staleOpen = decide(resolved.state, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_reordered",
      sourceStreamVersion: 1,
      status: "open",
      lifecycleAt: "2026-07-01T00:00:00.000Z",
    });
    const duplicate = decide(resolved.state, {
      type: "RecordReviewScoringSupportFact",
      orderId,
      supportRequestId: "sup_reordered",
      sourceStreamVersion: 3,
      status: "resolved",
      responsibility: "carrier",
      lifecycleAt: "2026-07-03T00:00:00.000Z",
    });

    expect(staleOpen.events).toEqual([]);
    expect(duplicate.events).toEqual([]);
  });

  it("rebuilds the identical directional state from a full event replay", () => {
    const commands: ReviewScoringCommand[] = [
      {
        type: "RecordReviewScoringSupportFact",
        orderId,
        supportRequestId: "sup_partial_refund",
        sourceStreamVersion: 1,
        status: "open",
        lifecycleAt: "2026-07-01T00:00:00.000Z",
      },
      {
        type: "RecordReviewScoringSupportFact",
        orderId,
        supportRequestId: "sup_partial_refund",
        sourceStreamVersion: 2,
        status: "resolved",
        responsibility: "seller",
        resolutionType: "partial-refund",
        lifecycleAt: "2026-07-02T00:00:00.000Z",
      },
    ];
    let live = initialReviewScoringState;
    const history = commands.flatMap((command) => {
      const result = decide(live, command);
      live = result.state;
      return result.events;
    });

    const replayed = applyEvents(initialReviewScoringState, evolveReviewScoring, history);

    expect(replayed).toEqual(live);
    expect(replayed.buyerToSeller.scoringDisposition).toBe("included");
    expect(replayed.sellerToBuyer.scoringDisposition).toBe("context-only");
  });
});
