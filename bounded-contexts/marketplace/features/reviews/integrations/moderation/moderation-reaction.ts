import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

/**
 * Review moderation reaction (m108): platform-operations' reported
 * content queue is the operator surface for BOTH listings and reviews (the
 * queue is built once, for both target types, not duplicated), but the review domain
 * commands live in marketplace, where the review aggregate is owned. This
 * reaction is the sanctioned cross-context bridge: it reads
 * platform-operations' `reported-content.action-recorded` event stream and,
 * for review-scoped actions, dispatches the matching marketplace review
 * domain command -- mirroring the `eligibility-sync` pattern of a consuming
 * context reacting to a foreign context's events with its own commands
 * rather than a direct cross-context call.
 */

export type ReviewModerationReactionDeps = Readonly<{
  operatorWithdrawReview: (
    params: Readonly<{ reviewId: string; operatorUserId: string; reason: string }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
  operatorRedactReviewFeedback: (
    params: Readonly<{ reviewId: string; operatorUserId: string; reason: string }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
  operatorWithdrawReviewReply: (
    params: Readonly<{ reviewId: string; operatorUserId: string; reason: string }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
}>;

type ReportedContentActionRecordedEvent = Readonly<{
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
  data: Readonly<{
    targetType: string;
    targetId: string;
    action: string;
    note: string | null;
    operatorUserId: string | null;
  }>;
}>;

function subscriptionEventContext(event: ReportedContentActionRecordedEvent): EventStoreContext {
  return {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };
}

const FALLBACK_OPERATOR_USER_ID = "unknown-operator";

export function buildReviewModerationReactionHandlers(deps: ReviewModerationReactionDeps): ProjectorHandlerMap {
  return {
    "platform-operations.reported-content.action-recorded": async (event) => {
      const typedEvent = event as unknown as ReportedContentActionRecordedEvent;
      const data = typedEvent.data;
      if (data.targetType !== "review") {
        return;
      }

      const context = subscriptionEventContext(typedEvent);
      const operatorUserId = data.operatorUserId ?? FALLBACK_OPERATOR_USER_ID;
      // The route layer requires a note for every review-scoped action before
      // the event is ever appended, so `note` is always populated here; the
      // fallback only guards a replay of a legacy/malformed event.
      const reason = data.note?.trim() || "Moderation action recorded without a reason.";

      switch (data.action) {
        case "withdraw-review":
          await deps.operatorWithdrawReview({ reviewId: data.targetId, operatorUserId, reason }, context);
          return;
        case "redact-review-feedback":
          await deps.operatorRedactReviewFeedback({ reviewId: data.targetId, operatorUserId, reason }, context);
          return;
        case "withdraw-review-reply":
          await deps.operatorWithdrawReviewReply({ reviewId: data.targetId, operatorUserId, reason }, context);
          return;
        default:
          // Generic listing-shaped actions (dismiss/contact-seller/etc.)
          // never target a review; nothing to react to.
          return;
      }
    },
  };
}
