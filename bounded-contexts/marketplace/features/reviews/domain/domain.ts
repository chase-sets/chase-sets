import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, OrderId, ReviewId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeFeedback,
  normalizeRating,
  normalizeReviewRole,
  normalizeReviewStatus,
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

export type ReviewCommand = SubmitReviewCommand | UpdateReviewCommand | WithdrawReviewCommand;

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

export type ReviewEvent = ReviewSubmittedEvent | ReviewUpdatedEvent | ReviewWithdrawnEvent;

export const decideReview: AggregateDecider<ReviewState, ReviewCommand, ReviewEvent> = (state, command) => {
  switch (command.type) {
    case "SubmitReview":
      assert(state.reviewId === null, "Review has already been submitted.");
      assert(command.authorAccountId !== command.subjectAccountId, "Accounts cannot review themselves.");

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
            submittedAt: ensureIsoTimestamp(command.submittedAt, "Review submission must record a timestamp."),
          },
        },
      ];
    case "UpdateReview":
      assert(state.reviewId !== null, "Review must be submitted first.");
      assert(state.status === "active", "Only active reviews can be updated.");

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

      return [
        {
          type: "marketplace.review.withdrawn",
          data: {
            reviewId: state.reviewId,
            withdrawnAt: ensureIsoTimestamp(command.withdrawnAt, "Review withdrawal must record a timestamp."),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveReview: AggregateEvolver<ReviewState, ReviewEvent> = (state, event) => {
  switch (event.type) {
    case "marketplace.review.submitted":
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
      };
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
    default:
      return assertNever(event);
  }
};
