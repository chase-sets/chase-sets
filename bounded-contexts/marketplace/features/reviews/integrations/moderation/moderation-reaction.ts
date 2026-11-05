import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { parsePlatformOperationsReportedContentActionRecordedPayload } from "@chase-sets/event-core/public-event-payloads";
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

function subscriptionEventContext(event: Pick<EventStoreContext, "tenantId" | "audit" | "trace">): EventStoreContext {
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
      const data = parsePlatformOperationsReportedContentActionRecordedPayload(event.data);
      if (data.targetType !== "review") {
        return;
      }

      const context = subscriptionEventContext(event);
      const operatorUserId = data.operatorUserId ?? FALLBACK_OPERATOR_USER_ID;
      // The closed audit contract requires a nonblank note on every review-scoped action.
      const reason = data.note?.trim() ?? "";

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
          // Generic actions (dismiss, contact-seller, escalation) need no review command.
          return;
      }
    },
  };
}
