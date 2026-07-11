import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, OrderId, ReviewId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeFeedback,
  normalizeRating,
  normalizeRevealReason,
  normalizeReviewRole,
  normalizeReviewStatus,
  type ReviewRevealReason,
  type ReviewRole,
  type ReviewStatus,
} from "./common";
import { normalizeResolutionContext, type ReviewResolutionContext } from "@chase-sets/review-eligibility";

export type ReviewState = Readonly<{
  reviewId: ReviewId | null;
  orderId: OrderId | null;
  authorAccountId: AccountId | null;
  subjectAccountId: AccountId | null;
  authorRole: ReviewRole | null;
  rating: number | null;
  feedback: string | null;
  status: ReviewStatus | null;
  resolutionContext: ReviewResolutionContext | null;
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
  resolutionContext: null,
  submittedAt: null,
  updatedAt: null,
  withdrawnAt: null,
  revealedAt: null,
  revealReason: null,
  reviewWindowExpiresAt: null,
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
  // Neutral display marker copied from the review-eligibility row when the
  // transaction was unlocked by a refund-class support resolution.
  resolutionContext?: string | null;
  submittedAt: string;
  // The submission-eligibility deadline (eligible_at + REVIEW_WINDOW_DAYS),
  // computed by the runtime from the eligibility row. Rejected here too (not
  // just at the runtime boundary) so the domain invariant holds regardless of
  // caller: a review cannot be submitted once its window has closed.
  reviewWindowExpiresAt: string;
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

export type ReviewCommand = SubmitReviewCommand | UpdateReviewCommand | WithdrawReviewCommand | RevealReviewCommand;

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
    resolutionContext: ReviewResolutionContext | null;
    submittedAt: string;
    reviewWindowExpiresAt: string;
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

export type ReviewEvent = ReviewSubmittedEvent | ReviewUpdatedEvent | ReviewWithdrawnEvent | ReviewRevealedEvent;

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

      return [
        {
          type: "marketplace.review.submitted",
          data: {
            reviewId: command.reviewId,
            orderId: command.orderId,
            authorAccountId: command.authorAccountId,
            subjectAccountId: command.subjectAccountId,
            authorRole: normalizeReviewRole(command.authorRole),
            rating: normalizeRating(command.rating),
            feedback: normalizeFeedback(command.feedback),
            resolutionContext: normalizeResolutionContext(command.resolutionContext),
            submittedAt,
            reviewWindowExpiresAt,
          },
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
        // Events persisted before the marker existed replay with undefined.
        resolutionContext: normalizeResolutionContext(event.data.resolutionContext ?? null),
        status: "active",
        submittedAt: event.data.submittedAt,
        updatedAt: event.data.submittedAt,
        withdrawnAt: null,
        revealedAt: isPreReveal ? null : event.data.submittedAt,
        revealReason: isPreReveal ? null : "window-expired",
        reviewWindowExpiresAt,
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
      };
    case "marketplace.review.revealed":
      return {
        ...state,
        revealedAt: event.data.revealedAt,
        revealReason: normalizeRevealReason(event.data.reason),
        updatedAt: event.data.revealedAt,
      };
    default:
      return assertNever(event);
  }
};
