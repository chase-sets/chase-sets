import { describe, expect, it, vi } from "vitest";
import { buildReviewModerationReactionHandlers } from "./moderation-reaction";

function baseEvent(
  overrides: Partial<{
    targetType: string;
    targetId: string;
    action: string;
    note: string | null;
    operatorUserId: string | null;
    reporterAccountId: string;
  }>,
) {
  return {
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
    trace: {},
    data: {
      actionId: "rca_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      recordedAt: "2026-07-11T00:00:00.000Z",
      targetType: "review",
      targetId: "rev_1",
      action: "withdraw-review",
      note: "Abusive language.",
      operatorUserId: "usr_operator",
      ...overrides,
    },
  } as never;
}

describe("review moderation reaction", () => {
  it("dispatches an operator withdraw for a withdraw-review action", async () => {
    const operatorWithdrawReview = vi.fn().mockResolvedValue(undefined);
    const operatorRedactReviewFeedback = vi.fn().mockResolvedValue(undefined);
    const operatorWithdrawReviewReply = vi.fn().mockResolvedValue(undefined);
    const handlers = buildReviewModerationReactionHandlers({
      operatorWithdrawReview,
      operatorRedactReviewFeedback,
      operatorWithdrawReviewReply,
    });

    await handlers["platform-operations.reported-content.action-recorded"]?.(baseEvent({}));

    expect(operatorWithdrawReview).toHaveBeenCalledWith(
      { reviewId: "rev_1", operatorUserId: "usr_operator", reason: "Abusive language." },
      { tenantId: "tnt_1", audit: { performedByUserId: "usr_system", forAccountId: "acc_system" }, trace: {} },
    );
    expect(operatorRedactReviewFeedback).not.toHaveBeenCalled();
    expect(operatorWithdrawReviewReply).not.toHaveBeenCalled();
  });

  it("dispatches feedback redaction for a redact-review-feedback action", async () => {
    const operatorRedactReviewFeedback = vi.fn().mockResolvedValue(undefined);
    const handlers = buildReviewModerationReactionHandlers({
      operatorWithdrawReview: vi.fn(),
      operatorRedactReviewFeedback,
      operatorWithdrawReviewReply: vi.fn(),
    });

    await handlers["platform-operations.reported-content.action-recorded"]?.(
      baseEvent({ action: "redact-review-feedback", note: "PII in the text." }),
    );

    expect(operatorRedactReviewFeedback).toHaveBeenCalledWith(
      { reviewId: "rev_1", operatorUserId: "usr_operator", reason: "PII in the text." },
      expect.anything(),
    );
  });

  it("dispatches reply withdrawal for a withdraw-review-reply action", async () => {
    const operatorWithdrawReviewReply = vi.fn().mockResolvedValue(undefined);
    const handlers = buildReviewModerationReactionHandlers({
      operatorWithdrawReview: vi.fn(),
      operatorRedactReviewFeedback: vi.fn(),
      operatorWithdrawReviewReply,
    });

    await handlers["platform-operations.reported-content.action-recorded"]?.(
      baseEvent({ action: "withdraw-review-reply", note: "Reply contained PII." }),
    );

    expect(operatorWithdrawReviewReply).toHaveBeenCalledWith(
      { reviewId: "rev_1", operatorUserId: "usr_operator", reason: "Reply contained PII." },
      expect.anything(),
    );
  });

  it("ignores listing-targeted actions", async () => {
    const operatorWithdrawReview = vi.fn();
    const handlers = buildReviewModerationReactionHandlers({
      operatorWithdrawReview,
      operatorRedactReviewFeedback: vi.fn(),
      operatorWithdrawReviewReply: vi.fn(),
    });

    await handlers["platform-operations.reported-content.action-recorded"]?.(
      baseEvent({ targetType: "listing", targetId: "lst_1", action: "unlist", note: null }),
    );

    expect(operatorWithdrawReview).not.toHaveBeenCalled();
  });

  it("ignores generic actions on a review target (dismiss, contact-seller, escalate)", async () => {
    const operatorWithdrawReview = vi.fn();
    const operatorRedactReviewFeedback = vi.fn();
    const operatorWithdrawReviewReply = vi.fn();
    const handlers = buildReviewModerationReactionHandlers({
      operatorWithdrawReview,
      operatorRedactReviewFeedback,
      operatorWithdrawReviewReply,
    });

    for (const action of ["dismiss", "contact-seller", "escalate-account-suspension"]) {
      await handlers["platform-operations.reported-content.action-recorded"]?.(baseEvent({ action, note: null }));
    }

    expect(operatorWithdrawReview).not.toHaveBeenCalled();
    expect(operatorRedactReviewFeedback).not.toHaveBeenCalled();
    expect(operatorWithdrawReviewReply).not.toHaveBeenCalled();
  });

  it.each([
    ["an action outside the review partition", { action: "unlist" }],
    ["a review action without a note", { note: "  " }],
    ["an unknown field", { reporterAccountId: "acc_reporter" }],
  ])("poisons %s through the shared closed parser before dispatching", async (_name, overrides) => {
    const deps = {
      operatorWithdrawReview: vi.fn(),
      operatorRedactReviewFeedback: vi.fn(),
      operatorWithdrawReviewReply: vi.fn(),
    };
    const handlers = buildReviewModerationReactionHandlers(deps);

    await expect(
      handlers["platform-operations.reported-content.action-recorded"]!(baseEvent(overrides)),
    ).rejects.toThrow(/^Reported Content /);
    for (const dispatch of Object.values(deps)) expect(dispatch).not.toHaveBeenCalled();
  });
});
