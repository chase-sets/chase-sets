import { describe, expect, it } from "vitest";
import { decideReview, evolveReview, initialReviewState, type ReviewSubmittedEvent } from "./domain";

describe("marketplace review domain", () => {
  it("submits reviews in both transaction directions", async () => {
    const buyerToSeller = await decideReview(initialReviewState, {
      type: "SubmitReview",
      reviewId: "rev_buyer_to_seller" as never,
      orderId: "ord_1" as never,
      authorAccountId: "acc_buyer" as never,
      subjectAccountId: "acc_seller" as never,
      authorRole: "buyer",
      rating: 5,
      feedback: "Seller packed carefully.",
      submittedAt: "2026-04-02T00:00:00.000Z",
      reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
    });
    const sellerToBuyer = await decideReview(initialReviewState, {
      type: "SubmitReview",
      reviewId: "rev_seller_to_buyer" as never,
      orderId: "ord_1" as never,
      authorAccountId: "acc_seller" as never,
      subjectAccountId: "acc_buyer" as never,
      authorRole: "seller",
      rating: 4,
      feedback: "Buyer paid promptly.",
      submittedAt: "2026-04-02T00:05:00.000Z",
      reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
    });

    expect(buyerToSeller[0]?.data).toMatchObject({
      authorAccountId: "acc_buyer",
      subjectAccountId: "acc_seller",
      authorRole: "buyer",
    });
    expect(sellerToBuyer[0]?.data).toMatchObject({
      authorAccountId: "acc_seller",
      subjectAccountId: "acc_buyer",
      authorRole: "seller",
    });
  });

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
      reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
    });
    const submittedState = submittedEvents.reduce(evolveReview, initialReviewState);
    expect(submittedState.revealedAt).toBeNull();

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
    const withdrawnState = withdrawnEvents.reduce(evolveReview, updatedState);

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
          reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("Accounts cannot review themselves.");
  });

  it("rejects submission once the review window has closed", async () => {
    await expect(
      Promise.resolve().then(() =>
        decideReview(initialReviewState, {
          type: "SubmitReview",
          reviewId: "rev_1" as never,
          orderId: "ord_1" as never,
          authorAccountId: "acc_buyer" as never,
          subjectAccountId: "acc_seller" as never,
          authorRole: "buyer",
          rating: 5,
          feedback: "Late.",
          submittedAt: "2026-06-02T00:00:00.000Z",
          reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("This transaction's review window has closed.");
  });

  async function submitAndReveal(overrides: { reason: "counterpart-submitted" | "window-expired" }) {
    const submittedEvents = await decideReview(initialReviewState, {
      type: "SubmitReview",
      reviewId: "rev_1" as never,
      orderId: "ord_1" as never,
      authorAccountId: "acc_buyer" as never,
      subjectAccountId: "acc_seller" as never,
      authorRole: "buyer",
      rating: 5,
      feedback: "Fast shipping.",
      submittedAt: "2026-04-02T00:00:00.000Z",
      reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
    });
    const submittedState = submittedEvents.reduce(evolveReview, initialReviewState);

    const revealedEvents = await decideReview(submittedState, {
      type: "RevealReview",
      revealedAt: "2026-04-05T00:00:00.000Z",
      reason: overrides.reason,
    });
    const revealedState = revealedEvents.reduce(evolveReview, submittedState);
    return { revealedEvents, revealedState, submittedState };
  }

  it("reveals a review when the counterpart submits", async () => {
    const { revealedEvents, revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

    expect(revealedEvents).toHaveLength(1);
    expect(revealedEvents[0]?.type).toBe("marketplace.review.revealed");
    expect(revealedState.revealedAt).toBe("2026-04-05T00:00:00.000Z");
    expect(revealedState.revealReason).toBe("counterpart-submitted");
  });

  it("reveals a singleton review once its window expires", async () => {
    const { revealedState } = await submitAndReveal({ reason: "window-expired" });

    expect(revealedState.revealedAt).toBe("2026-04-05T00:00:00.000Z");
    expect(revealedState.revealReason).toBe("window-expired");
  });

  it("reveal is idempotent", async () => {
    const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

    const secondReveal = await decideReview(revealedState, {
      type: "RevealReview",
      revealedAt: "2026-04-06T00:00:00.000Z",
      reason: "window-expired",
    });

    expect(secondReveal).toEqual([]);
  });

  it("reveal on a withdrawn review is a no-op", async () => {
    const submittedEvents = await decideReview(initialReviewState, {
      type: "SubmitReview",
      reviewId: "rev_1" as never,
      orderId: "ord_1" as never,
      authorAccountId: "acc_buyer" as never,
      subjectAccountId: "acc_seller" as never,
      authorRole: "buyer",
      rating: 5,
      feedback: "Fast shipping.",
      submittedAt: "2026-04-02T00:00:00.000Z",
      reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
    });
    const submittedState = submittedEvents.reduce(evolveReview, initialReviewState);
    const withdrawnEvents = await decideReview(submittedState, {
      type: "WithdrawReview",
      withdrawnAt: "2026-04-03T00:00:00.000Z",
    });
    const withdrawnState = withdrawnEvents.reduce(evolveReview, submittedState);

    const revealEvents = await decideReview(withdrawnState, {
      type: "RevealReview",
      revealedAt: "2026-04-04T00:00:00.000Z",
      reason: "window-expired",
    });

    expect(revealEvents).toEqual([]);
  });

  it("evolves a pre-reveal-window submitted event (replay of pre-launch history) as already revealed", () => {
    const legacyEvent = {
      type: "marketplace.review.submitted",
      data: {
        reviewId: "rev_legacy" as never,
        orderId: "ord_1" as never,
        authorAccountId: "acc_buyer" as never,
        subjectAccountId: "acc_seller" as never,
        authorRole: "buyer",
        rating: 5,
        feedback: "Pre-launch review.",
        submittedAt: "2026-01-02T00:00:00.000Z",
        // reviewWindowExpiresAt intentionally omitted: pre-migration shape.
      },
    } as unknown as ReviewSubmittedEvent;

    const state = evolveReview(initialReviewState, legacyEvent);

    expect(state.status).toBe("active");
    expect(state.revealedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(state.revealReason).toBe("window-expired");
  });

  it("blocks updates and withdrawal once a review has been revealed", async () => {
    const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

    await expect(
      Promise.resolve().then(() =>
        decideReview(revealedState, {
          type: "UpdateReview",
          rating: 1,
          feedback: "Trying to change it after reveal.",
          updatedAt: "2026-04-06T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("Reviews cannot be edited after they are revealed.");

    await expect(
      Promise.resolve().then(() =>
        decideReview(revealedState, {
          type: "WithdrawReview",
          withdrawnAt: "2026-04-06T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("Reviews cannot be withdrawn after they are revealed.");
  });

  describe("operator moderation (m108, #4269)", () => {
    it("withdraws a revealed review, which the author cannot do", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

      const events = await decideReview(revealedState, {
        type: "OperatorWithdrawReview",
        withdrawnAt: "2026-04-07T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "Abusive language.",
      });
      const state = events.reduce(evolveReview, revealedState);

      expect(events[0]?.data).toMatchObject({
        actorType: "operator",
        operatorUserId: "usr_operator",
        reason: "Abusive language.",
      });
      expect(state.status).toBe("withdrawn");
      expect(state.withdrawnByActorType).toBe("operator");
      expect(state.moderationOperatorUserId).toBe("usr_operator");
      expect(state.moderationReason).toBe("Abusive language.");
    });

    it("operator withdrawal is idempotent", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });
      const firstEvents = await decideReview(revealedState, {
        type: "OperatorWithdrawReview",
        withdrawnAt: "2026-04-07T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "Abusive language.",
      });
      const withdrawnState = firstEvents.reduce(evolveReview, revealedState);

      const secondEvents = await decideReview(withdrawnState, {
        type: "OperatorWithdrawReview",
        withdrawnAt: "2026-04-08T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "Abusive language.",
      });

      expect(secondEvents).toEqual([]);
    });

    it("requires a reason for operator withdrawal", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

      await expect(
        Promise.resolve().then(() =>
          decideReview(revealedState, {
            type: "OperatorWithdrawReview",
            withdrawnAt: "2026-04-07T00:00:00.000Z",
            operatorUserId: "usr_operator",
            reason: "  ",
          }),
        ),
      ).rejects.toThrow("A moderation reason is required.");
    });

    it("redacts review feedback while the rating stands", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

      const events = await decideReview(revealedState, {
        type: "OperatorRedactReviewFeedback",
        redactedAt: "2026-04-07T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "PII in the text.",
      });
      const state = events.reduce(evolveReview, revealedState);

      expect(state.feedback).toBeNull();
      expect(state.rating).toBe(revealedState.rating);
      expect(state.feedbackRedactedAt).toBe("2026-04-07T00:00:00.000Z");
      expect(state.moderationReason).toBe("PII in the text.");
    });

    it("redaction is idempotent once feedback is already null", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });
      const firstEvents = await decideReview(revealedState, {
        type: "OperatorRedactReviewFeedback",
        redactedAt: "2026-04-07T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "PII in the text.",
      });
      const redactedState = firstEvents.reduce(evolveReview, revealedState);

      const secondEvents = await decideReview(redactedState, {
        type: "OperatorRedactReviewFeedback",
        redactedAt: "2026-04-08T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "PII in the text.",
      });

      expect(secondEvents).toEqual([]);
    });

    it("cannot redact a withdrawn review", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });
      const withdrawnEvents = await decideReview(revealedState, {
        type: "OperatorWithdrawReview",
        withdrawnAt: "2026-04-07T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "Abusive language.",
      });
      const withdrawnState = withdrawnEvents.reduce(evolveReview, revealedState);

      await expect(
        Promise.resolve().then(() =>
          decideReview(withdrawnState, {
            type: "OperatorRedactReviewFeedback",
            redactedAt: "2026-04-08T00:00:00.000Z",
            operatorUserId: "usr_operator",
            reason: "PII in the text.",
          }),
        ),
      ).rejects.toThrow("Withdrawn reviews cannot be redacted.");
    });
  });

  describe("subject reply (m108, #4269)", () => {
    it("lets the subject reply once, after reveal", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

      const events = await decideReview(revealedState, {
        type: "SubmitReviewReply",
        replyId: "rvr_1" as never,
        subjectAccountId: revealedState.subjectAccountId as unknown as string,
        feedback: "Thanks for the feedback -- resolved via replacement.",
        submittedAt: "2026-04-06T00:00:00.000Z",
      });
      const state = events.reduce(evolveReview, revealedState);

      expect(events[0]?.type).toBe("marketplace.review.reply-submitted");
      expect(state.replyStatus).toBe("active");
      expect(state.replyFeedback).toBe("Thanks for the feedback -- resolved via replacement.");
      expect(state.replySubmittedAt).toBe("2026-04-06T00:00:00.000Z");
    });

    it("rejects a reply before the review is revealed", async () => {
      const submittedEvents = await decideReview(initialReviewState, {
        type: "SubmitReview",
        reviewId: "rev_1" as never,
        orderId: "ord_1" as never,
        authorAccountId: "acc_buyer" as never,
        subjectAccountId: "acc_seller" as never,
        authorRole: "buyer",
        rating: 5,
        feedback: "Fast shipping.",
        submittedAt: "2026-04-02T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
      });
      const submittedState = submittedEvents.reduce(evolveReview, initialReviewState);

      await expect(
        Promise.resolve().then(() =>
          decideReview(submittedState, {
            type: "SubmitReviewReply",
            replyId: "rvr_1" as never,
            subjectAccountId: "acc_seller",
            feedback: "Too soon.",
            submittedAt: "2026-04-02T00:05:00.000Z",
          }),
        ),
      ).rejects.toThrow("Reviews cannot be replied to before they are revealed.");
    });

    it("rejects a reply from anyone other than the subject", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

      await expect(
        Promise.resolve().then(() =>
          decideReview(revealedState, {
            type: "SubmitReviewReply",
            replyId: "rvr_1" as never,
            subjectAccountId: "acc_someone_else",
            feedback: "Not the subject.",
            submittedAt: "2026-04-06T00:00:00.000Z",
          }),
        ),
      ).rejects.toThrow("Only the review subject may reply.");
    });

    it("rejects a second reply -- one threaded response only, no flame wars", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });
      const firstReplyEvents = await decideReview(revealedState, {
        type: "SubmitReviewReply",
        replyId: "rvr_1" as never,
        subjectAccountId: revealedState.subjectAccountId as unknown as string,
        feedback: "First reply.",
        submittedAt: "2026-04-06T00:00:00.000Z",
      });
      const repliedState = firstReplyEvents.reduce(evolveReview, revealedState);

      await expect(
        Promise.resolve().then(() =>
          decideReview(repliedState, {
            type: "SubmitReviewReply",
            replyId: "rvr_2" as never,
            subjectAccountId: revealedState.subjectAccountId as unknown as string,
            feedback: "Second reply attempt.",
            submittedAt: "2026-04-06T01:00:00.000Z",
          }),
        ),
      ).rejects.toThrow("A reply already exists for this review.");
    });

    it("lets an operator withdraw a reply", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });
      const replyEvents = await decideReview(revealedState, {
        type: "SubmitReviewReply",
        replyId: "rvr_1" as never,
        subjectAccountId: revealedState.subjectAccountId as unknown as string,
        feedback: "First reply.",
        submittedAt: "2026-04-06T00:00:00.000Z",
      });
      const repliedState = replyEvents.reduce(evolveReview, revealedState);

      const withdrawEvents = await decideReview(repliedState, {
        type: "OperatorWithdrawReviewReply",
        withdrawnAt: "2026-04-07T00:00:00.000Z",
        operatorUserId: "usr_operator",
        reason: "Reply contained PII.",
      });
      const state = withdrawEvents.reduce(evolveReview, repliedState);

      expect(state.replyStatus).toBe("withdrawn");
      expect(state.replyWithdrawnAt).toBe("2026-04-07T00:00:00.000Z");
    });

    it("rejects withdrawing a reply that does not exist", async () => {
      const { revealedState } = await submitAndReveal({ reason: "counterpart-submitted" });

      await expect(
        Promise.resolve().then(() =>
          decideReview(revealedState, {
            type: "OperatorWithdrawReviewReply",
            withdrawnAt: "2026-04-07T00:00:00.000Z",
            operatorUserId: "usr_operator",
            reason: "No reply exists.",
          }),
        ),
      ).rejects.toThrow("No reply exists for this review.");
    });
  });
});
