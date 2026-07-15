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
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import {
  addReviewWindowDays,
  assert,
  normalizeRating,
  normalizeRequiredText,
  normalizeReviewRole,
  ReputationDomainError,
  REVIEW_WINDOW_DAYS,
  type ReviewRole,
} from "../domain/common";
import { syncReviewEligibilityForOrder } from "../integrations/source/eligibility-sync";
import { mapReviewReminderToNotification } from "../integrations/notifications/notification-intents";
import { buildReviewNotificationProjectionHandlers } from "../integrations/notifications/notification-projector";
import { buildReviewProjectionHandlers } from "../read-model/projection";
import {
  findActiveReviewForDirection,
  findPendingCounterpartReview,
  getAccountIdBySlug,
  getAccountReview,
  getOrderReviewOpportunity,
  getPublicAccountSummary,
  getReviewEligibility,
  getReviewOrderBuyerEmail,
  listPendingCounterpartPairs,
  listPendingReviewsPastWindow,
  listPublicAccountReviews,
  listReceivedReviews,
  listReviewOpportunityReminderCandidates,
  listWrittenReviews,
  markReviewOpportunityReminderNotified,
} from "../read-model/queries";
import {
  decideReview,
  evolveReview,
  initialReviewState,
  type ReviewCommand,
  type ReviewEvent,
  type ReviewState,
} from "../domain/domain";
import {
  decideReviewHold,
  evolveReviewHold,
  initialReviewHoldState,
  isReviewDirectionHeld,
  reviewDirectionForAuthorRole,
  type ReviewDirection,
  type ReviewHoldCommand,
  type ReviewHoldEvent,
  type ReviewHoldState,
} from "../domain/review-hold";
import { buildReviewHoldProjectionHandlers } from "../read-model/hold-projection";

type ReviewRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  /** Post-delivery review nudges (m108). Defaults to a noop so every
   * existing caller (services wiring aside) keeps working unchanged. */
  notificationOutbox?: NotificationOutbox;
}>;

export type ReviewWindowSweepResult = Readonly<{
  counterpartPairsRevealed: number;
  windowExpiredRevealed: number;
}>;

export type ReviewOpportunityReminderSweepResult = Readonly<{
  remindersSent: number;
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
  /** Operator moderation (m108): allowed regardless of reveal state. */
  operatorWithdrawReview: (
    params: Readonly<{ reviewId: string; operatorUserId: string; reason: string }>,
    context: EventStoreContext,
  ) => Promise<{ reviewId: string; version: number }>;
  /** Operator moderation (m108): rating stands, text is removed. */
  operatorRedactReviewFeedback: (
    params: Readonly<{ reviewId: string; operatorUserId: string; reason: string }>,
    context: EventStoreContext,
  ) => Promise<{ reviewId: string; version: number }>;
  /** Subject reply (m108): one threaded response, subject-only, post-reveal only. */
  submitReviewReply: (
    params: Readonly<{ reviewId: string; subjectAccountId: string; feedback: string }>,
    context: EventStoreContext,
  ) => Promise<{ reviewId: string; replyId: string; version: number }>;
  /** Operator moderation of a subject reply (m108). */
  operatorWithdrawReviewReply: (
    params: Readonly<{ reviewId: string; operatorUserId: string; reason: string }>,
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
  recordSupportRequestOpened: (
    params: Readonly<{
      orderId: string;
      supportRequestId: string;
      openedAt: string;
      directions?: readonly ReviewDirection[];
    }>,
    context: EventStoreContext,
  ) => Promise<void>;
  recordSupportRequestTerminal: (
    params: Readonly<{
      orderId: string;
      supportRequestId: string;
      terminalAt: string;
      terminalStatus: "resolved" | "cancelled";
    }>,
    context: EventStoreContext,
  ) => Promise<void>;
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
  /**
   * Post-delivery review nudge reminder sweep (m108). Mirrors the
   * review-window sweep pattern: a periodic scan rather than per-event
   * scheduling. Fires exactly one reminder per (order, direction) -- eligible
   * long enough ago, still unsubmitted, still inside the submission window --
   * then marks it notified so the next sweep never re-selects it. Suspension
   * (eligibility row deleted) and expiry (window closed) both fall out of the
   * candidate query with no separate cancellation step.
   */
  sweepReviewOpportunityReminders: (
    params: Readonly<{ now?: string; limit?: number }>,
  ) => Promise<ReviewOpportunityReminderSweepResult>;
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
  const reviewRuntime = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ReviewEvent>(),
    initialState: () => initialReviewState,
    evolve: evolveReview,
    decide: decideReview,
  });
  const { commandHandler } = reviewRuntime;
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const reviewHoldRuntime = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ReviewHoldEvent>(),
    initialState: () => initialReviewHoldState,
    evolve: evolveReviewHold,
    decide: decideReviewHold,
  });

  async function loadReviewHold(orderId: string): Promise<ReviewHoldState> {
    return (await reviewHoldRuntime.repository.load(`marketplace.review-hold-${orderId}`)).state;
  }

  async function isDirectionHeld(orderId: string, authorRole: ReviewRole): Promise<boolean> {
    return isReviewDirectionHeld(await loadReviewHold(orderId), reviewDirectionForAuthorRole(authorRole));
  }

  async function isAnyDirectionHeld(orderId: string): Promise<boolean> {
    const hold = await loadReviewHold(orderId);
    return isReviewDirectionHeld(hold, "buyer-to-seller") || isReviewDirectionHeld(hold, "seller-to-buyer");
  }

  async function recordReviewHold(command: ReviewHoldCommand, context: EventStoreContext): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await reviewHoldRuntime.commandHandler({
          streamId: `marketplace.review-hold-${command.orderId}`,
          command,
          context,
        });
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "concurrency_conflict" || attempt === 2) {
          throw error;
        }
      }
    }
  }

  function heldError(): ReputationDomainError {
    return new ReputationDomainError("Review is paused while support reviews the order.", "review_held");
  }

  return {
    commandHandler,
    recordSupportRequestOpened: async (params, context) => {
      const orderId = normalizeRequiredText(params.orderId, "Order is required.") as OrderId;
      await recordReviewHold(
        {
          type: "RecordReviewHoldOpened",
          orderId,
          supportRequestId: params.supportRequestId,
          openedAt: params.openedAt,
          ...(params.directions ? { directions: params.directions } : {}),
        },
        context,
      );
    },
    recordSupportRequestTerminal: async (params, context) => {
      const orderId = normalizeRequiredText(params.orderId, "Order is required.") as OrderId;
      await recordReviewHold(
        {
          type: "RecordReviewHoldTerminal",
          orderId,
          supportRequestId: params.supportRequestId,
          terminalAt: params.terminalAt,
          terminalStatus: params.terminalStatus,
        },
        context,
      );
    },
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
      await syncReviewEligibilityForOrder(deps.db, orderId, params.deliveredAt, { outbox: notificationOutbox });
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

      const authorRole = inferAuthorRoleFromEligibility(eligibility.author_role);
      const effectiveDeadlineAt =
        eligibility.effective_deadline_at ?? addReviewWindowDays(eligibility.eligible_at, REVIEW_WINDOW_DAYS);
      const submissionState =
        eligibility.submission_state ??
        (Date.parse(new Date().toISOString()) >= Date.parse(effectiveDeadlineAt) ? "expired" : "allowed");
      if (submissionState === "held" || (await isDirectionHeld(orderId, authorRole))) {
        throw heldError();
      }
      if (submissionState === "expired") {
        throw new ReputationDomainError("This transaction's review window has closed.");
      }

      const submittedAt = new Date().toISOString();
      const reviewWindowExpiresAt = effectiveDeadlineAt;
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
          authorRole,
          rating: normalizeRating(params.rating),
          feedback: params.feedback ?? null,
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
      if (counterpart && !(await isAnyDirectionHeld(orderId))) {
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
      if (review.held || (await isDirectionHeld(review.order_id, inferAuthorRoleFromEligibility(review.author_role)))) {
        throw heldError();
      }
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
      if (review.held || (await isDirectionHeld(review.order_id, inferAuthorRoleFromEligibility(review.author_role)))) {
        throw heldError();
      }
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
    async operatorWithdrawReview(params, context) {
      const result = await commandHandler({
        streamId: `marketplace.review-${params.reviewId}`,
        command: {
          type: "OperatorWithdrawReview",
          withdrawnAt: new Date().toISOString(),
          operatorUserId: params.operatorUserId,
          reason: params.reason,
        },
        context,
      });

      return { reviewId: params.reviewId, version: result.version };
    },
    async operatorRedactReviewFeedback(params, context) {
      const result = await commandHandler({
        streamId: `marketplace.review-${params.reviewId}`,
        command: {
          type: "OperatorRedactReviewFeedback",
          redactedAt: new Date().toISOString(),
          operatorUserId: params.operatorUserId,
          reason: params.reason,
        },
        context,
      });

      return { reviewId: params.reviewId, version: result.version };
    },
    async submitReviewReply(params, context) {
      const review = (await reviewRuntime.repository.load(`marketplace.review-${params.reviewId}`)).state;
      if (
        review.orderId !== null &&
        review.authorRole !== null &&
        (await isDirectionHeld(review.orderId, review.authorRole))
      ) {
        throw heldError();
      }
      const replyId = createId("rvr");
      const result = await commandHandler({
        streamId: `marketplace.review-${params.reviewId}`,
        command: {
          type: "SubmitReviewReply",
          replyId,
          subjectAccountId: params.subjectAccountId,
          feedback: params.feedback,
          submittedAt: new Date().toISOString(),
        },
        context,
      });

      return { reviewId: params.reviewId, replyId, version: result.version };
    },
    async operatorWithdrawReviewReply(params, context) {
      const result = await commandHandler({
        streamId: `marketplace.review-${params.reviewId}`,
        command: {
          type: "OperatorWithdrawReviewReply",
          withdrawnAt: new Date().toISOString(),
          operatorUserId: params.operatorUserId,
          reason: params.reason,
        },
        context,
      });

      return { reviewId: params.reviewId, version: result.version };
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
        if (await isAnyDirectionHeld(pair.order_id)) {
          continue;
        }
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
        if (await isDirectionHeld(candidate.order_id, inferAuthorRoleFromEligibility(candidate.author_role))) {
          continue;
        }
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
    async sweepReviewOpportunityReminders(params) {
      const now = params.now ?? new Date().toISOString();
      const limit = params.limit ?? 100;
      let remindersSent = 0;

      const candidates = await listReviewOpportunityReminderCandidates(deps.db, { now, limit });
      for (const candidate of candidates) {
        const authorRole = normalizeReviewRole(candidate.author_role);
        const [subjectResult, buyerEmail] = await Promise.all([
          deps.db.query<{ display_name: string | null }>(
            `SELECT display_name FROM marketplace_review_account_sources WHERE account_id = $1`,
            [candidate.subject_account_id],
          ),
          authorRole === "buyer" ? getReviewOrderBuyerEmail(deps.db, candidate.order_id) : Promise.resolve(null),
        ]);

        await notificationOutbox.enqueueNotification({
          message: mapReviewReminderToNotification({
            orderId: candidate.order_id,
            authorAccountId: candidate.author_account_id as AccountId,
            authorRole,
            subjectDisplayName: subjectResult.rows[0]?.display_name ?? null,
            buyerEmail,
            eligibleAt: candidate.eligible_at,
            correlationId: `marketplace-review-opportunity-reminder-sweep:${candidate.order_id}:${candidate.author_account_id}`,
          }),
          source: {
            sourceEventId: `marketplace-review-opportunity-reminder-sweep:${candidate.order_id}:${candidate.author_account_id}`,
            sourceGlobalPosition: "0",
            projectionName: "marketplace-review-opportunity-reminder-sweep",
            occurredAt: now,
          },
        });
        await markReviewOpportunityReminderNotified(deps.db, {
          orderId: candidate.order_id,
          authorAccountId: candidate.author_account_id,
          subjectAccountId: candidate.subject_account_id,
          notifiedAt: now,
        });
        remindersSent += 1;
      }

      return { remindersSent };
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
      createProjectionHandlerSet({
        projectionName: "marketplace-review-hold-projection",
        handlers: buildReviewHoldProjectionHandlers(deps.db),
        streamPrefixes: ["marketplace.review-hold-"],
      }),
      // Reveal-notice nudge (m108): same-context local projector, same
      // stream as the read-model projection above (see
      // notification-projector.ts for why reading marketplace_review_pages
      // here is safe).
      createProjectionHandlerSet({
        projectionName: "marketplace-review-notification-projection",
        handlers: buildReviewNotificationProjectionHandlers(deps.db, notificationOutbox),
        streamPrefixes: ["marketplace.review-"],
      }),
    ],
  };
}
