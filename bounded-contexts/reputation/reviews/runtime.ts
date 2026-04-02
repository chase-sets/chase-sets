import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
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
} from "../common";
import { buildReputationReviewProjectionHandlers } from "./projection";
import {
  findActiveReviewForDirection,
  getAccountReview,
  getPublicAccountSummary,
  getReviewEligibility,
  listPublicAccountReviews,
  listReceivedReviews,
  listWrittenReviews,
} from "./queries";
import {
  decideReputationReview,
  evolveReputationReview,
  initialReputationReviewState,
  type ReputationReviewCommand,
  type ReputationReviewEvent,
  type ReputationReviewState,
} from "./domain";

type ReviewRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type ReputationReviewServices = Readonly<{
  commandHandler: CommandHandler<
    ReputationReviewCommand,
    ReputationReviewState,
    ReputationReviewEvent
  >;
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
  listWrittenReviews: (
    params: Parameters<typeof listWrittenReviews>[1],
  ) => ReturnType<typeof listWrittenReviews>;
  listReceivedReviews: (
    params: Parameters<typeof listReceivedReviews>[1],
  ) => ReturnType<typeof listReceivedReviews>;
  getAccountReview: (
    reviewId: string,
    accountId: string,
  ) => ReturnType<typeof getAccountReview>;
  getPublicAccountSummary: (
    accountId: string,
  ) => ReturnType<typeof getPublicAccountSummary>;
  projectors: readonly Projector[];
}>;

function inferAuthorRoleFromEligibility(
  role: string,
): ReviewRole {
  return role === "seller" ? "seller" : "buyer";
}

async function requireOwnedReview(
  db: PgQueryable,
  reviewId: string,
  authorAccountId: string,
) {
  const review = await getAccountReview(db, reviewId, authorAccountId);
  if (!review || review.author_account_id !== authorAccountId) {
    throw new ReputationDomainError("Review not found.");
  }
  return review;
}

export function createReputationReviewRuntime(
  deps: ReviewRuntimeDeps,
): ReputationReviewServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ReputationReviewEvent>(),
      initialState: () => initialReputationReviewState,
      evolve: evolveReputationReview,
    }),
    evolve: evolveReputationReview,
    decide: decideReputationReview,
  });

  return {
    commandHandler,
    async submitReview(params, context) {
      const orderId = normalizeRequiredText(
        params.orderId,
        "Order is required.",
      ) as OrderId;
      const authorAccountId = normalizeRequiredText(
        params.authorAccountId,
        "Author account is required.",
      ) as AccountId;
      const subjectAccountId = normalizeRequiredText(
        params.subjectAccountId,
        "Review subject is required.",
      ) as AccountId;

      assert(
        authorAccountId !== subjectAccountId,
        "Accounts cannot review themselves.",
      );

      const eligibility = await getReviewEligibility(deps.db, {
        orderId,
        authorAccountId,
        subjectAccountId,
      });
      if (!eligibility) {
        throw new ReputationDomainError(
          "This transaction is not eligible for review yet.",
        );
      }

      const existingReview = await findActiveReviewForDirection(deps.db, {
        orderId,
        authorAccountId,
        subjectAccountId,
      });
      if (existingReview) {
        throw new ReputationDomainError(
          "An active review already exists for this order and direction.",
        );
      }

      const reviewId = createId("rev") as ReviewId;
      const submittedAt = new Date().toISOString();
      const result = await commandHandler({
        streamId: `reputation.review-${reviewId}`,
        command: {
          type: "SubmitReview",
          reviewId,
          orderId,
          authorAccountId,
          subjectAccountId,
          authorRole: inferAuthorRoleFromEligibility(eligibility.author_role),
          rating: normalizeRating(params.rating),
          feedback: params.feedback ?? null,
          submittedAt,
        },
        context,
      });

      return { reviewId, version: result.version };
    },
    async updateReview(params, context) {
      const review = await requireOwnedReview(
        deps.db,
        params.reviewId,
        params.authorAccountId,
      );
      if (review.status !== "active") {
        throw new ReputationDomainError("Only active reviews can be updated.");
      }

      const result = await commandHandler({
        streamId: `reputation.review-${review.review_id}`,
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
      const review = await requireOwnedReview(
        deps.db,
        params.reviewId,
        params.authorAccountId,
      );

      const result = await commandHandler({
        streamId: `reputation.review-${review.review_id}`,
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
    getAccountReview: (reviewId, accountId) =>
      getAccountReview(deps.db, reviewId, accountId),
    getPublicAccountSummary: (accountId) =>
      getPublicAccountSummary(deps.db, accountId),
    projectors: [
      createProjector({
        projectorName: "reputation-review-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildReputationReviewProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "reputation-review-eligibility",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: {
          "fulfillment.shipment.delivered": async (event) => {
            const data = event.data as {
              shipmentId: string;
              deliveredAt: string;
            };

            const shipmentResult = await deps.db.query<{ order_id: string }>(
              `SELECT order_id
               FROM fulfillment_shipment_pages
               WHERE shipment_id = $1`,
              [data.shipmentId],
            );
            const orderId = shipmentResult.rows[0]?.order_id;
            if (!orderId) {
              return;
            }

            const orderResult = await deps.db.query<{
              buyer_account_id: string;
              seller_account_id: string;
            }>(
              `SELECT buyer_account_id, seller_account_id
               FROM ordering_order_pages
               WHERE order_id = $1`,
              [orderId],
            );
            const order = orderResult.rows[0];
            if (!order) {
              return;
            }

            const upsertEligibility = async (
              authorAccountId: string,
              subjectAccountId: string,
              authorRole: ReviewRole,
            ) => {
              await deps.db.query(
                `INSERT INTO reputation_review_eligibility_pages (
                   order_id,
                   author_account_id,
                   subject_account_id,
                   author_role,
                   eligible_at,
                   updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $5)
                 ON CONFLICT (order_id, author_account_id, subject_account_id) DO UPDATE
                 SET author_role = EXCLUDED.author_role,
                     eligible_at = LEAST(
                       reputation_review_eligibility_pages.eligible_at,
                       EXCLUDED.eligible_at
                     ),
                     updated_at = EXCLUDED.updated_at`,
                [
                  orderId,
                  authorAccountId,
                  subjectAccountId,
                  authorRole,
                  data.deliveredAt,
                ],
              );
            };

            await upsertEligibility(
              order.buyer_account_id,
              order.seller_account_id,
              "buyer",
            );
            await upsertEligibility(
              order.seller_account_id,
              order.buyer_account_id,
              "seller",
            );
          },
        },
      }),
    ],
  };
}
