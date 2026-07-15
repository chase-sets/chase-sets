import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { FeedbackCaseId, FeedbackCaseFollowUpChannel } from "../../domain";
import type { FeedbackCaseLifecycleCommand } from "../../api/runtime";

type ExecuteByCaseId = (
  caseId: FeedbackCaseId,
  command: FeedbackCaseLifecycleCommand,
  context: Parameters<EventStore["appendToStream"]>[0]["context"],
) => Promise<unknown>;

type DeliveryReportedData = Readonly<{
  purpose: "attention" | "follow-up" | "digest";
  caseId: string | null;
  attentionId: string | null;
  digestId: string | null;
  deliveryReference: string;
  outcome: "sent" | "failed" | "suppressed" | "retry-exhausted";
  channel: string;
  templateVersion: number;
  reportedAt: string;
}>;

export function buildNotificationDeliveryReactionHandlers(
  executeByCaseId: ExecuteByCaseId,
  eventStore: EventStore,
): ProjectorHandlerMap {
  return {
    "notifications.customer-feedback.delivery-reported": async (event) => {
      const data = event.data as DeliveryReportedData;
      const context = { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
      if (data.purpose === "follow-up" && data.caseId) {
        await executeByCaseId(
          data.caseId as FeedbackCaseId,
          {
            type: "RecordFeedbackCaseFollowUpDeliveryOutcome",
            deliveryReference: data.deliveryReference,
            outcome: data.outcome,
            channel: data.channel as FeedbackCaseFollowUpChannel,
            templateVersion: data.templateVersion,
            actor: { actorId: "notifications.delivery-reporter", authority: "notify-feedback-cases" },
            actedAt: data.reportedAt,
          },
          context,
        );
        return;
      }
      if (data.purpose === "attention" && data.caseId && data.attentionId) {
        await executeByCaseId(
          data.caseId as FeedbackCaseId,
          {
            type: "RecordFeedbackCaseAttentionDeliveryOutcome",
            attentionId: data.attentionId,
            deliveryReference: data.deliveryReference,
            outcome: data.outcome,
            actor: { actorId: "notifications.delivery-reporter", authority: "notify-feedback-cases" },
            actedAt: data.reportedAt,
          },
          context,
        );
        return;
      }
      if (data.purpose === "digest" && data.digestId) {
        const outcomeId = createHash("sha256").update(event.id).digest("hex");
        try {
          await eventStore.appendToStream({
            streamId: `customer-feedback.attention-digest-outcome-${outcomeId}`,
            expectedVersion: "no_stream",
            context,
            events: [
              {
                eventType: "customer-feedback.attention.digest-delivery-outcome-recorded",
                payload: {
                  eventSchemaVersion: 1,
                  digestId: data.digestId,
                  deliveryReference: data.deliveryReference,
                  outcome: data.outcome,
                  reportedAt: data.reportedAt,
                },
                occurredAt: data.reportedAt as never,
              },
            ],
          });
        } catch (error) {
          if (!isConcurrencyConflict(error)) throw error;
        }
      }
    },
  };
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
