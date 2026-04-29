import { describe, expect, it } from "vitest";
import {
  decideReview,
  evolveReview,
  initialReviewState,
} from "./domain";

describe("reputation review domain", () => {
  it("submits, updates, and withdraws a review", async () => {
    const submittedEvents = await decideReview(initialReviewState, {
      type: "SubmitReview",
      reviewId: "rev_1" as never,
      orderId: "ord_1" as never,
      authorAccountId: "acc_buyer" as never,
      subjectAccountId: "acc_seller" as never,
      authorRole: "buyer",
      rating: 5,
      feedback: "Fast shipping and careful packaging.",
      submittedAt: "2026-04-02T00:00:00.000Z",
    });
    const submittedState = submittedEvents.reduce(
      evolveReview,
      initialReviewState,
    );

    const updatedEvents = await decideReview(submittedState, {
      type: "UpdateReview",
      rating: 4,
      feedback: "Strong transaction overall.",
      updatedAt: "2026-04-02T01:00:00.000Z",
    });
    const updatedState = updatedEvents.reduce(evolveReview, submittedState);

    const withdrawnEvents = await decideReview(updatedState, {
      type: "WithdrawReview",
      withdrawnAt: "2026-04-03T00:00:00.000Z",
    });
    const withdrawnState = withdrawnEvents.reduce(
      evolveReview,
      updatedState,
    );

    expect(withdrawnState.status).toBe("withdrawn");
    expect(withdrawnState.rating).toBe(4);
    expect(withdrawnState.feedback).toBe("Strong transaction overall.");
    expect(withdrawnState.withdrawnAt).toBe("2026-04-03T00:00:00.000Z");
  });

  it("rejects self-review submission", async () => {
    await expect(
      Promise.resolve().then(() =>
        decideReview(initialReviewState, {
          type: "SubmitReview",
          reviewId: "rev_1" as never,
          orderId: "ord_1" as never,
        authorAccountId: "acc_buyer" as never,
        subjectAccountId: "acc_buyer" as never,
        authorRole: "buyer",
          rating: 5,
          feedback: "Nope.",
          submittedAt: "2026-04-02T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("Accounts cannot review themselves.");
  });
});
