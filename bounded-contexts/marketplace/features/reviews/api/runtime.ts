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
  addReviewWindowDays,
  assert,
  normalizeRating,
  normalizeRequiredText,
  ReputationDomainError,
  REVIEW_WINDOW_DAYS,
  type ReviewRole,
} from "../domain/common";
import { syncReviewEligibilityForOrder } from "../integrations/source/eligibility-sync";
import { buildReviewProjectionHandlers } from "../read-model/projection";
import {
  findActiveReviewForDirection,
  findPendingCounterpartReview,
  getAccountIdBySlug,
  getAccountReview,
  getOrderReviewOpportunity,
  getPublicAccountSummary,
  getReviewEligibility,
  listPendingCounterpartPairs,
  listPendingReviewsPastWindow,
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

export type ReviewWindowSweepResult = Readonly<{
  counterpartPairsRevealed: number;
  windowExpiredRevealed: number;
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
  /** Resolves a public seller slug (MCP `subjectAccountSlug` input) to its canonical account id, or null if unknown. */
  resolveAccountIdBySlug: (slug: string) => ReturnType<typeof getAccountIdBySlug>;
  getOrderReviewOpportunity: (orderId: string, authorAccountId: string) => ReturnType<typeof getOrderReviewOpportunity>;
  recordDeliveredShipmentReviewEligibility: (params: { shipmentId: string; deliveredAt: string }) => Promise<void>;
  /**
   * Double-blind reveal expiry sweep (m108). Self-heals any pending
   * review pair whose counterpart-submission reveal was missed by the
   * submission-time check (a narrow concurrent-submission race), then reveals
   * every singleton review whose submission window has elapsed with no
   * counterpart. Idempotent and safe to run concurrently: `RevealReview` is a
   * no-op once a review is already revealed or withdrawn.
   */
  sweepReviewWindowExpirations: (
    params: Readonly<{ now?: string; limit?: number }>,
    context: EventStoreContext,
  ) => Promise<ReviewWindowSweepResult>;
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

/** eligible_at + REVIEW_WINDOW_DAYS: both the submission deadline and the expiry sweep's singleton-reveal deadline. */
function computeReviewWindowExpiresAt(eligibleAt: string): string {
  return addReviewWindowDays(eligibleAt, REVIEW_WINDOW_DAYS);
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

      const submittedAt = new Date().toISOString();
      const reviewWindowExpiresAt = computeReviewWindowExpiresAt(eligibility.eligible_at);
      if (Date.parse(submittedAt) >= Date.parse(reviewWindowExpiresAt)) {
        // Route-layer enforcement of the same deadline the domain decider
        // re-asserts below -- belt and suspenders, one shared computation.
        throw new ReputationDomainError("This transaction's review window has closed.");
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
          reviewWindowExpiresAt,
        },
        context,
      });

      // Double-blind reveal (m108): if the counterpart review for this
      // order already submitted and is still pending, reveal both now rather
      // than waiting on the expiry sweep. A genuinely concurrent double
      // submission (neither side's read-model row visible to the other yet)
      // is self-healed by the sweep's pair pass.
      const counterpart = await findPendingCounterpartReview(deps.db, {
        orderId,
        counterpartAuthorAccountId: subjectAccountId,
        counterpartSubjectAccountId: authorAccountId,
      });
      if (counterpart) {
        const revealedAt = new Date().toISOString();
        await commandHandler({
          streamId: `marketplace.review-${reviewId}`,
          command: { type: "RevealReview", revealedAt, reason: "counterpart-submitted" },
          context,
        });
        await commandHandler({
          streamId: `marketplace.review-${counterpart.review_id}`,
          command: { type: "RevealReview", revealedAt, reason: "counterpart-submitted" },
          context,
        });
      }

      return { reviewId, version: result.version };
    },
    async updateReview(params, context) {
      const review = await requireOwnedReview(deps.db, params.reviewId, params.authorAccountId);
      if (review.status !== "active") {
        throw new ReputationDomainError("Only active reviews can be updated.");
      }
      if (review.revealed_at !== null) {
        throw new ReputationDomainError("Reviews cannot be edited after they are revealed.");
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
      if (review.status === "active" && review.revealed_at !== null) {
        throw new ReputationDomainError("Reviews cannot be withdrawn after they are revealed.");
      }

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
    async sweepReviewWindowExpirations(params, context) {
      const now = params.now ?? new Date().toISOString();
      const limit = params.limit ?? 100;
      let counterpartPairsRevealed = 0;
      let windowExpiredRevealed = 0;

      // 1. Self-heal any pending pair the submission-time check missed (a
      // narrow concurrent-submission race): reveal both sides together.
      const pairs = await listPendingCounterpartPairs(deps.db, { limit });
      for (const pair of pairs) {
        const revealedAt = new Date().toISOString();
        const first = await commandHandler({
          streamId: `marketplace.review-${pair.review_id}`,
          command: { type: "RevealReview", revealedAt, reason: "counterpart-submitted" },
          context,
        });
        const second = await commandHandler({
          streamId: `marketplace.review-${pair.counterpart_review_id}`,
          command: { type: "RevealReview", revealedAt, reason: "counterpart-submitted" },
          context,
        });
        if (first.newEvents.length > 0 || second.newEvents.length > 0) {
          counterpartPairsRevealed += 1;
        }
      }

      // 2. Reveal singleton reviews whose submission window elapsed with no
      // counterpart ever submitting.
      const expired = await listPendingReviewsPastWindow(deps.db, { now, limit });
      for (const candidate of expired) {
        const result = await commandHandler({
          streamId: `marketplace.review-${candidate.review_id}`,
          command: { type: "RevealReview", revealedAt: now, reason: "window-expired" },
          context,
        });
        if (result.newEvents.length > 0) {
          windowExpiredRevealed += 1;
        }
      }

      return { counterpartPairsRevealed, windowExpiredRevealed };
    },
    listPublicAccountReviews: (params) => listPublicAccountReviews(deps.db, params),
    listWrittenReviews: (params) => listWrittenReviews(deps.db, params),
    listReceivedReviews: (params) => listReceivedReviews(deps.db, params),
    getAccountReview: (reviewId, accountId) => getAccountReview(deps.db, reviewId, accountId),
    getPublicAccountSummary: (accountId) => getPublicAccountSummary(deps.db, accountId),
    resolveAccountIdBySlug: (slug) => getAccountIdBySlug(deps.db, slug),
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
