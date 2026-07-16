import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, OrderId, ReviewId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeMarketplaceReviewSubmittedScoring,
  type MarketplaceReviewScoringDisposition,
  type MarketplaceReviewScoringReasonCode,
  type MarketplaceReviewScoringSourceFactVersion,
} from "@chase-sets/event-core/review-scoring-facts";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeFeedback,
  normalizeModerationReason,
  normalizeRating,
  normalizeReplyFeedback,
  normalizeRequiredText,
  normalizeRevealReason,
  normalizeReviewRole,
  normalizeReviewStatus,
  type ReviewRevealReason,
  type ReviewRole,
  type ReviewStatus,
} from "./common";
import {
  createReputationCsatOutcomeFact,
  reputationCsatOutcomeFactEventType,
} from "../../../support/request-support/csat-outcome-fact";

export type ReviewState = Readonly<{
  reviewId: ReviewId | null;
  orderId: OrderId | null;
  authorAccountId: AccountId | null;
  subjectAccountId: AccountId | null;
  authorRole: ReviewRole | null;
  rating: number | null;
  feedback: string | null;
  status: ReviewStatus | null;
  submittedAt: string | null;
  updatedAt: string | null;
  withdrawnAt: string | null;
  // Double-blind reveal (m108). `reviewWindowExpiresAt` is captured at
  // submission from the eligibility deadline and never changes; it is both
  // the domain-enforced submission deadline and the expiry sweep's reveal
  // deadline for a review whose counterpart never submits.
  revealedAt: string | null;
  revealReason: ReviewRevealReason | null;
  reviewWindowExpiresAt: string | null;
  // Moderation (m108). `withdrawnByActorType` distinguishes an
  // author-initiated withdrawal (blocked post-reveal) from an
  // operator-initiated one (the only path once a review is revealed).
  // `moderationReason` holds the latest operator withdraw/redact reason for
  // display; the authoritative audit trail is the event stream itself.
  withdrawnByActorType: "author" | "operator" | null;
  moderationOperatorUserId: string | null;
  moderationReason: string | null;
  feedbackRedactedAt: string | null;
  // Subject reply: one threaded, moderatable response per review.
  replyId: string | null;
  replyFeedback: string | null;
  replyStatus: "active" | "withdrawn" | null;
  replySubmittedAt: string | null;
  replyWithdrawnAt: string | null;
}>;

export const initialReviewState: ReviewState = {
  reviewId: null,
  orderId: null,
  authorAccountId: null,
  subjectAccountId: null,
  authorRole: null,
  rating: null,
  feedback: null,
  status: null,
  submittedAt: null,
  updatedAt: null,
  withdrawnAt: null,
  revealedAt: null,
  revealReason: null,
  reviewWindowExpiresAt: null,
  withdrawnByActorType: null,
  moderationOperatorUserId: null,
  moderationReason: null,
  feedbackRedactedAt: null,
  replyId: null,
  replyFeedback: null,
  replyStatus: null,
  replySubmittedAt: null,
  replyWithdrawnAt: null,
};

export type SubmitReviewCommand = Readonly<{
  type: "SubmitReview";
  reviewId: ReviewId;
  orderId: OrderId;
  authorAccountId: AccountId;
  subjectAccountId: AccountId;
  authorRole: ReviewRole;
  rating: number;
  feedback?: string | null;
  submittedAt: string;
  // The submission-eligibility deadline (eligible_at + REVIEW_WINDOW_DAYS),
  // computed by the runtime from the eligibility row. Rejected here too (not
  // just at the runtime boundary) so the domain invariant holds regardless of
  // caller: a review cannot be submitted once its window has closed.
  reviewWindowExpiresAt: string;
  scoringDisposition?: MarketplaceReviewScoringDisposition;
  scoringReasonCode?: MarketplaceReviewScoringReasonCode;
  scoringPolicyVersion?: string;
  scoringSourceFactVersions?: readonly MarketplaceReviewScoringSourceFactVersion[];
  scoringOperationalSignal?: "responsibility-missing" | "responsibility-unrecognized" | null;
}>;

export type UpdateReviewCommand = Readonly<{
  type: "UpdateReview";
  rating: number;
  feedback?: string | null;
  updatedAt: string;
}>;

export type WithdrawReviewCommand = Readonly<{
  type: "WithdrawReview";
  withdrawnAt: string;
}>;

/**
 * Operator moderation (m108): removes the review from display and
 * every downstream aggregate while preserving the full event history. Unlike
 * the author's own `WithdrawReview`, this is allowed regardless of reveal
 * state -- post-reveal author withdrawal is blocked by design and routes
 * through moderation instead.
 */
export type OperatorWithdrawReviewCommand = Readonly<{
  type: "OperatorWithdrawReview";
  withdrawnAt: string;
  operatorUserId: string;
  reason: string;
}>;

/**
 * Operator moderation (m108): removes abusive/PII-laden review text
 * while the rating stands. Idempotent no-op when there is no feedback left to
 * redact.
 */
export type OperatorRedactReviewFeedbackCommand = Readonly<{
  type: "OperatorRedactReviewFeedback";
  redactedAt: string;
  operatorUserId: string;
  reason: string;
}>;

/**
 * Subject reply (m108): one threaded public response per review,
 * authored only by the review's subject, only once the review is revealed
 * (the subject cannot respond to content it cannot yet see).
 */
export type SubmitReviewReplyCommand = Readonly<{
  type: "SubmitReviewReply";
  replyId: string;
  subjectAccountId: string;
  feedback: string;
  submittedAt: string;
}>;

/** Operator moderation of a subject reply, mirroring review withdrawal. */
export type OperatorWithdrawReviewReplyCommand = Readonly<{
  type: "OperatorWithdrawReviewReply";
  withdrawnAt: string;
  operatorUserId: string;
  reason: string;
}>;

/**
 * Reveals a hidden review, either because the counterpart review for the
 * same order just submitted (both directions reveal together) or because the
 * submission window elapsed with no counterpart (this review reveals alone).
 * Idempotent: revealing an already-revealed review is a no-op, so the
 * counterpart-submission callback and the expiry sweep can never race into a
 * duplicate reveal.
 */
export type RevealReviewCommand = Readonly<{
  type: "RevealReview";
  revealedAt: string;
  reason: ReviewRevealReason;
}>;

export type ReviewCommand =
  | SubmitReviewCommand
  | UpdateReviewCommand
  | WithdrawReviewCommand
  | RevealReviewCommand
  | OperatorWithdrawReviewCommand
  | OperatorRedactReviewFeedbackCommand
  | SubmitReviewReplyCommand
  | OperatorWithdrawReviewReplyCommand;

export type ReviewSubmittedEvent = DomainEvent<
  "marketplace.review.submitted",
  Readonly<{
    reviewId: ReviewId;
    orderId: OrderId;
    authorAccountId: AccountId;
    subjectAccountId: AccountId;
    authorRole: ReviewRole;
    rating: number;
    feedback: string | null;
    submittedAt: string;
    reviewWindowExpiresAt: string;
    scoringDisposition?: MarketplaceReviewScoringDisposition;
    scoringReasonCode?: MarketplaceReviewScoringReasonCode;
    scoringPolicyVersion?: string;
    scoringSourceFactVersions?: readonly MarketplaceReviewScoringSourceFactVersion[];
    scoringOperationalSignal?: "responsibility-missing" | "responsibility-unrecognized" | null;
  }>
>;

export type ReviewUpdatedEvent = DomainEvent<
  "marketplace.review.updated",
  Readonly<{
    reviewId: ReviewId;
    rating: number;
    feedback: string | null;
    updatedAt: string;
  }>
>;

export type ReviewWithdrawnEvent = DomainEvent<
  "marketplace.review.withdrawn",
  Readonly<{
    reviewId: ReviewId;
    withdrawnAt: string;
    // Present only for operator-initiated withdrawals (m108) -- the
    // audit trail this AC requires: every moderation action is an event with
    // actor + reason. Absent (undefined) for the author's own withdrawal.
    actorType?: "operator";
    operatorUserId?: string;
    reason?: string;
  }>
>;

export type ReviewFeedbackRedactedEvent = DomainEvent<
  "marketplace.review.feedback-redacted",
  Readonly<{
    reviewId: ReviewId;
    redactedAt: string;
    operatorUserId: string;
    reason: string;
  }>
>;

export type ReviewReplySubmittedEvent = DomainEvent<
  "marketplace.review.reply-submitted",
  Readonly<{
    reviewId: ReviewId;
    replyId: string;
    subjectAccountId: AccountId;
    feedback: string;
    submittedAt: string;
  }>
>;

export type ReviewReplyWithdrawnEvent = DomainEvent<
  "marketplace.review.reply-withdrawn",
  Readonly<{
    reviewId: ReviewId;
    withdrawnAt: string;
    operatorUserId: string;
    reason: string;
  }>
>;

export type ReviewRevealedEvent = DomainEvent<
  "marketplace.review.revealed",
  Readonly<{
    reviewId: ReviewId;
    revealedAt: string;
    reason: ReviewRevealReason;
  }>
>;

export type ReputationCsatOutcomeFactPublishedEvent = DomainEvent<
  typeof reputationCsatOutcomeFactEventType,
  ReturnType<typeof createReputationCsatOutcomeFact>
>;

export type ReviewEvent =
  | ReviewSubmittedEvent
  | ReviewUpdatedEvent
  | ReviewWithdrawnEvent
  | ReviewRevealedEvent
  | ReviewFeedbackRedactedEvent
  | ReviewReplySubmittedEvent
  | ReviewReplyWithdrawnEvent
  | ReputationCsatOutcomeFactPublishedEvent;

export const decideReview: AggregateDecider<ReviewState, ReviewCommand, ReviewEvent> = (state, command) => {
  switch (command.type) {
    case "SubmitReview": {
      assert(state.reviewId === null, "Review has already been submitted.");
      assert(command.authorAccountId !== command.subjectAccountId, "Accounts cannot review themselves.");

      const submittedAt = ensureIsoTimestamp(command.submittedAt, "Review submission must record a timestamp.");
      const reviewWindowExpiresAt = ensureIsoTimestamp(
        command.reviewWindowExpiresAt,
        "Review submission must record a review window deadline.",
      );
      assert(
        Date.parse(submittedAt) < Date.parse(reviewWindowExpiresAt),
        "This transaction's review window has closed.",
      );

      const authorRole = normalizeReviewRole(command.authorRole);
      const scoring = normalizeMarketplaceReviewSubmittedScoring(command);
      return [
        {
          type: "marketplace.review.submitted",
          data: {
            reviewId: command.reviewId,
            orderId: command.orderId,
            authorAccountId: command.authorAccountId,
            subjectAccountId: command.subjectAccountId,
            authorRole,
            rating: normalizeRating(command.rating),
            feedback: normalizeFeedback(command.feedback),
            submittedAt,
            reviewWindowExpiresAt,
            scoringDisposition: scoring.scoringDisposition,
            scoringReasonCode: scoring.reasonCode,
            scoringPolicyVersion: scoring.policyVersion,
            scoringSourceFactVersions: scoring.sourceFactVersions,
            scoringOperationalSignal:
              scoring.operationalSignal === "policy-version-unrecognized"
                ? "responsibility-unrecognized"
                : scoring.operationalSignal,
          },
        },
        {
          type: reputationCsatOutcomeFactEventType,
          data: createReputationCsatOutcomeFact({
            outcomeCode: "reputation.review-received",
            subjectAccountId: command.authorAccountId,
            subjectKind: authorRole === "buyer" ? "buyer" : "seller",
            subjectEntityType: "review",
            subjectEntityId: command.reviewId,
            outcomeOccurredAt: submittedAt,
            idempotencyKey: `review:${command.reviewId}:received`,
          }),
        },
      ];
    }
    case "UpdateReview":
      assert(state.reviewId !== null, "Review must be submitted first.");
      assert(state.status !== "withdrawn", "Withdrawn reviews cannot be updated.");
      assert(state.revealedAt === null, "Reviews cannot be edited after they are revealed.");

      return [
        {
          type: "marketplace.review.updated",
          data: {
            reviewId: state.reviewId,
            rating: normalizeRating(command.rating),
            feedback: normalizeFeedback(command.feedback),
            updatedAt: ensureIsoTimestamp(command.updatedAt, "Review update must record a timestamp."),
          },
        },
      ];
    case "WithdrawReview":
      assert(state.reviewId !== null, "Review must be submitted first.");
      if (state.status === "withdrawn") {
        return [];
      }
      assert(state.revealedAt === null, "Reviews cannot be withdrawn after they are revealed.");

      return [
        {
          type: "marketplace.review.withdrawn",
          data: {
            reviewId: state.reviewId,
            withdrawnAt: ensureIsoTimestamp(command.withdrawnAt, "Review withdrawal must record a timestamp."),
          },
        },
      ];
    case "RevealReview": {
      assert(state.reviewId !== null, "Review must be submitted first.");
      if (state.status === "withdrawn" || state.revealedAt !== null) {
        // Withdrawn: nothing to reveal. Already revealed: idempotent no-op so
        // the counterpart-submission callback and the expiry sweep can never
        // race into a duplicate reveal event.
        return [];
      }

      return [
        {
          type: "marketplace.review.revealed",
          data: {
            reviewId: state.reviewId,
            revealedAt: ensureIsoTimestamp(command.revealedAt, "Review reveal must record a timestamp."),
            reason: normalizeRevealReason(command.reason),
          },
        },
      ];
    }
    case "OperatorWithdrawReview": {
      assert(state.reviewId !== null, "Review must be submitted first.");
      if (state.status === "withdrawn") {
        return [];
      }

      return [
        {
          type: "marketplace.review.withdrawn",
          data: {
            reviewId: state.reviewId,
            withdrawnAt: ensureIsoTimestamp(command.withdrawnAt, "Review withdrawal must record a timestamp."),
            actorType: "operator",
            operatorUserId: normalizeRequiredText(command.operatorUserId, "Operator is required."),
            reason: normalizeModerationReason(command.reason),
          },
        },
      ];
    }
    case "OperatorRedactReviewFeedback": {
      assert(state.reviewId !== null, "Review must be submitted first.");
      assert(state.status !== "withdrawn", "Withdrawn reviews cannot be redacted.");
      if (state.feedback === null) {
        return [];
      }

      return [
        {
          type: "marketplace.review.feedback-redacted",
          data: {
            reviewId: state.reviewId,
            redactedAt: ensureIsoTimestamp(command.redactedAt, "Feedback redaction must record a timestamp."),
            operatorUserId: normalizeRequiredText(command.operatorUserId, "Operator is required."),
            reason: normalizeModerationReason(command.reason),
          },
        },
      ];
    }
    case "SubmitReviewReply": {
      assert(state.reviewId !== null, "Review must be submitted first.");
      assert(state.status === "active", "Withdrawn reviews cannot be replied to.");
      assert(state.revealedAt !== null, "Reviews cannot be replied to before they are revealed.");
      assert(command.subjectAccountId === state.subjectAccountId, "Only the review subject may reply.");
      assert(state.replyId === null, "A reply already exists for this review.");

      return [
        {
          type: "marketplace.review.reply-submitted",
          data: {
            reviewId: state.reviewId,
            replyId: normalizeRequiredText(command.replyId, "Reply id is required."),
            subjectAccountId: state.subjectAccountId,
            feedback: normalizeReplyFeedback(command.feedback),
            submittedAt: ensureIsoTimestamp(command.submittedAt, "Reply submission must record a timestamp."),
          },
        },
      ];
    }
    case "OperatorWithdrawReviewReply": {
      assert(state.replyId !== null, "No reply exists for this review.");
      if (state.replyStatus === "withdrawn") {
        return [];
      }

      return [
        {
          type: "marketplace.review.reply-withdrawn",
          data: {
            reviewId: state.reviewId as ReviewId,
            withdrawnAt: ensureIsoTimestamp(command.withdrawnAt, "Reply withdrawal must record a timestamp."),
            operatorUserId: normalizeRequiredText(command.operatorUserId, "Operator is required."),
            reason: normalizeModerationReason(command.reason),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveReview: AggregateEvolver<ReviewState, ReviewEvent> = (state, event) => {
  switch (event.type) {
    case "marketplace.review.submitted": {
      // Events persisted before the reveal window existed (pre-launch, m108)
      // replay with reviewWindowExpiresAt undefined. Treat those as
      // already revealed at submission so a full projection replay converges
      // on the same outcome as the one-time read-model migration: every
      // pre-launch review is revealed (AC: "existing reviews migrate
      // cleanly").
      const reviewWindowExpiresAt = event.data.reviewWindowExpiresAt ?? null;
      const isPreReveal = reviewWindowExpiresAt !== null;

      return {
        reviewId: event.data.reviewId,
        orderId: event.data.orderId,
        authorAccountId: event.data.authorAccountId,
        subjectAccountId: event.data.subjectAccountId,
        authorRole: normalizeReviewRole(event.data.authorRole),
        rating: normalizeRating(event.data.rating),
        feedback: normalizeFeedback(event.data.feedback),
        status: "active",
        submittedAt: event.data.submittedAt,
        updatedAt: event.data.submittedAt,
        withdrawnAt: null,
        revealedAt: isPreReveal ? null : event.data.submittedAt,
        revealReason: isPreReveal ? null : "window-expired",
        reviewWindowExpiresAt,
        withdrawnByActorType: null,
        moderationOperatorUserId: null,
        moderationReason: null,
        feedbackRedactedAt: null,
        replyId: null,
        replyFeedback: null,
        replyStatus: null,
        replySubmittedAt: null,
        replyWithdrawnAt: null,
      };
    }
    case "marketplace.review.updated":
      return {
        ...state,
        rating: normalizeRating(event.data.rating),
        feedback: normalizeFeedback(event.data.feedback),
        updatedAt: event.data.updatedAt,
      };
    case "marketplace.review.withdrawn":
      return {
        ...state,
        status: normalizeReviewStatus("withdrawn"),
        withdrawnAt: event.data.withdrawnAt,
        updatedAt: event.data.withdrawnAt,
        withdrawnByActorType: event.data.actorType ?? "author",
        moderationOperatorUserId: event.data.operatorUserId ?? null,
        moderationReason: event.data.reason ?? null,
      };
    case "marketplace.review.revealed":
      return {
        ...state,
        revealedAt: event.data.revealedAt,
        revealReason: normalizeRevealReason(event.data.reason),
        updatedAt: event.data.revealedAt,
      };
    case "marketplace.review.feedback-redacted":
      return {
        ...state,
        feedback: null,
        feedbackRedactedAt: event.data.redactedAt,
        moderationOperatorUserId: event.data.operatorUserId,
        moderationReason: event.data.reason,
        updatedAt: event.data.redactedAt,
      };
    case "marketplace.review.reply-submitted":
      return {
        ...state,
        replyId: event.data.replyId,
        replyFeedback: event.data.feedback,
        replyStatus: "active",
        replySubmittedAt: event.data.submittedAt,
        updatedAt: event.data.submittedAt,
      };
    case "marketplace.review.reply-withdrawn":
      return {
        ...state,
        replyStatus: "withdrawn",
        replyWithdrawnAt: event.data.withdrawnAt,
        updatedAt: event.data.withdrawnAt,
      };
    case reputationCsatOutcomeFactEventType:
      return state;
    default:
      return assertNever(event);
  }
};
