import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OrderId, ReviewId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  normalizeRating,
  normalizeRequiredText,
  ReputationDomainError,
  type ReviewRole,
} from "../domain/common";
import { syncReviewEligibilityForOrder } from "../integrations/source/eligibility-sync";
import { buildReviewProjectionHandlers } from "../read-model/projection";
import {
  findActiveReviewForDirection,
  getAccountReview,
  getOrderReviewOpportunity,
  getPublicAccountSummary,
  getReviewEligibility,
  listPublicAccountReviews,
  listReceivedReviews,
  listWrittenReviews,
} from "../read-model/queries";
import {
  decideReview,
  evolveReview,
  initialReviewState,
  type ReviewCommand,
  type ReviewEvent,
  type ReviewState,
} from "../domain/domain";

type ReviewRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type ReviewServices = Readonly<{
  commandHandler: CommandHandler<ReviewCommand, ReviewState, ReviewEvent>;
  submitReview: (
    params: Readonly<{
      orderId: string;
      authorAccountId: string;
      subjectAccountId: string;
      rating: number;
      feedback?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ reviewId: string; version: number }>;
  updateReview: (
    params: Readonly<{
      reviewId: string;
      authorAccountId: string;
      rating: number;
      feedback?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ reviewId: string; version: number }>;
  withdrawReview: (
    params: Readonly<{
      reviewId: string;
      authorAccountId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ reviewId: string; version: number }>;
  listPublicAccountReviews: (
    params: Parameters<typeof listPublicAccountReviews>[1],
  ) => ReturnType<typeof listPublicAccountReviews>;
  listWrittenReviews: (params: Parameters<typeof listWrittenReviews>[1]) => ReturnType<typeof listWrittenReviews>;
  listReceivedReviews: (params: Parameters<typeof listReceivedReviews>[1]) => ReturnType<typeof listReceivedReviews>;
  getAccountReview: (reviewId: string, accountId: string) => ReturnType<typeof getAccountReview>;
  getPublicAccountSummary: (accountId: string) => ReturnType<typeof getPublicAccountSummary>;
  getOrderReviewOpportunity: (orderId: string, authorAccountId: string) => ReturnType<typeof getOrderReviewOpportunity>;
  recordDeliveredShipmentReviewEligibility: (params: { shipmentId: string; deliveredAt: string }) => Promise<void>;
  projectors: readonly ProjectionHandlerSet[];
}>;

function inferAuthorRoleFromEligibility(role: string): ReviewRole {
  return role === "seller" ? "seller" : "buyer";
}

async function requireOwnedReview(db: PgQueryable, reviewId: string, authorAccountId: string) {
  const review = await getAccountReview(db, reviewId, authorAccountId);
  if (!review || review.author_account_id !== authorAccountId) {
    throw new ReputationDomainError("Review not found.");
  }
  return review;
}

export function createReviewRuntime(deps: ReviewRuntimeDeps): ReviewServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ReviewEvent>(),
    initialState: () => initialReviewState,
    evolve: evolveReview,
    decide: decideReview,
  });

  return {
    commandHandler,
    recordDeliveredShipmentReviewEligibility: async (params) => {
      const shipmentResult = await deps.db.query<{ order_id: string }>(
        `SELECT order_id
         FROM marketplace_review_shipment_sources
         WHERE shipment_id = $1
           AND status = 'delivered'`,
        [params.shipmentId],
      );
      const orderId = shipmentResult.rows[0]?.order_id;
      if (!orderId) {
        return;
      }

      // Delivery is one input to the eligibility matrix, not an unconditional
      // grant: the sync consults support-request history so, for example, the
      // delivered return leg of a return-for-refund never re-opens the
      // seller→buyer direction.
      await syncReviewEligibilityForOrder(deps.db, orderId, params.deliveredAt);
    },
    async submitReview(params, context) {
      const orderId = normalizeRequiredText(params.orderId, "Order is required.") as OrderId;
      const authorAccountId = normalizeRequiredText(params.authorAccountId, "Author account is required.") as AccountId;
      const subjectAccountId = normalizeRequiredText(
        params.subjectAccountId,
        "Review subject is required.",
      ) as AccountId;

      assert(authorAccountId !== subjectAccountId, "Accounts cannot review themselves.");

      const eligibility = await getReviewEligibility(deps.db, {
        orderId,
        authorAccountId,
        subjectAccountId,
      });
      if (!eligibility) {
        throw new ReputationDomainError("This transaction is not eligible for review yet.");
      }

      const existingReview = await findActiveReviewForDirection(deps.db, {
        orderId,
        authorAccountId,
        subjectAccountId,
      });
      if (existingReview) {
        throw new ReputationDomainError("An active review already exists for this order and direction.");
      }

      const reviewId = createId("rev") as ReviewId;
      const submittedAt = new Date().toISOString();
      const result = await commandHandler({
        streamId: `marketplace.review-${reviewId}`,
        command: {
          type: "SubmitReview",
          reviewId,
          orderId,
          authorAccountId,
          subjectAccountId,
          authorRole: inferAuthorRoleFromEligibility(eligibility.author_role),
          rating: normalizeRating(params.rating),
          feedback: params.feedback ?? null,
          resolutionContext: eligibility.resolution_context,
          submittedAt,
        },
        context,
      });

      return { reviewId, version: result.version };
    },
    async updateReview(params, context) {
      const review = await requireOwnedReview(deps.db, params.reviewId, params.authorAccountId);
      if (review.status !== "active") {
        throw new ReputationDomainError("Only active reviews can be updated.");
      }

      const result = await commandHandler({
        streamId: `marketplace.review-${review.review_id}`,
        command: {
          type: "UpdateReview",
          rating: normalizeRating(params.rating),
          feedback: params.feedback ?? null,
          updatedAt: new Date().toISOString(),
        },
        context,
      });

      return { reviewId: review.review_id, version: result.version };
    },
    async withdrawReview(params, context) {
      const review = await requireOwnedReview(deps.db, params.reviewId, params.authorAccountId);

      const result = await commandHandler({
        streamId: `marketplace.review-${review.review_id}`,
        command: {
          type: "WithdrawReview",
          withdrawnAt: new Date().toISOString(),
        },
        context,
      });

      return { reviewId: review.review_id, version: result.version };
    },
    listPublicAccountReviews: (params) => listPublicAccountReviews(deps.db, params),
    listWrittenReviews: (params) => listWrittenReviews(deps.db, params),
    listReceivedReviews: (params) => listReceivedReviews(deps.db, params),
    getAccountReview: (reviewId, accountId) => getAccountReview(deps.db, reviewId, accountId),
    getPublicAccountSummary: (accountId) => getPublicAccountSummary(deps.db, accountId),
    getOrderReviewOpportunity: (orderId, authorAccountId) =>
      getOrderReviewOpportunity(deps.db, { orderId, authorAccountId }),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-review-projection",
        handlers: buildReviewProjectionHandlers(deps.db),
        streamPrefixes: ["marketplace.review-"],
      }),
    ],
  };
}
