import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  NotificationDeliveryOutcomeReporter,
  NotificationDeliveryOutcomeReport,
} from "@chase-sets/outbound-messaging";

export type CustomerFeedbackNotificationPurpose = "attention" | "follow-up" | "digest";

export type CustomerFeedbackNotificationDeliveryReportedData = Readonly<{
  eventSchemaVersion: 1;
  purpose: CustomerFeedbackNotificationPurpose;
  caseId: string | null;
  attentionId: string | null;
  digestId: string | null;
  deliveryReference: string;
  outcome: NotificationDeliveryOutcomeReport["outcome"];
  channel: string;
  templateVersion: number;
  attemptCount: number;
  maxAttempts: number;
  reportedAt: string;
}>;

export function createCustomerFeedbackNotificationDeliveryOutcomeReporter(
  eventStore: EventStore,
): NotificationDeliveryOutcomeReporter {
  return {
    async reportNotificationDeliveryOutcome(report) {
      const reference = customerFeedbackReference(report);
      if (!reference) return;
      const data: CustomerFeedbackNotificationDeliveryReportedData = {
        eventSchemaVersion: 1,
        purpose: reference.purpose,
        caseId: reference.caseId,
        attentionId: reference.attentionId,
        digestId: reference.digestId,
        deliveryReference: report.deliveryId,
        outcome: report.outcome,
        channel: report.channel,
        templateVersion: report.message.templateVersion,
        attemptCount: report.attemptCount,
        maxAttempts: report.maxAttempts,
        reportedAt: report.reportedAt,
      };
      const reportKey = createHash("sha256")
        .update(`${report.deliveryId}\u0000${report.attemptCount}\u0000${report.outcome}`)
        .digest("hex");
      try {
        await eventStore.appendToStream({
          streamId: `notifications.customer-feedback-delivery-${reportKey}`,
          expectedVersion: "no_stream",
          context: {
            tenantId: reference.sourceTenantId as never,
            audit: {
              performedByUserId: "usr_notifications_delivery" as never,
              forAccountId: (report.message.recipientAccountId ?? "acc_platform") as never,
            },
            trace: { traceId: report.message.correlationId as never },
          },
          events: [
            {
              eventType: "notifications.customer-feedback.delivery-reported",
              payload: data as never,
              occurredAt: report.reportedAt as never,
            },
          ],
        });
      } catch (error) {
        if (!isConcurrencyConflict(error)) throw error;
      }
    },
  };
}

function customerFeedbackReference(report: NotificationDeliveryOutcomeReport): Readonly<{
  sourceTenantId: string;
  purpose: CustomerFeedbackNotificationPurpose;
  caseId: string | null;
  attentionId: string | null;
  digestId: string | null;
}> | null {
  const value = (key: string) => {
    const candidate = report.message.templateData[key];
    return typeof candidate === "string" && candidate.trim() ? candidate : null;
  };
  const sourceTenantId = value("sourceTenantId");
  if (!sourceTenantId) return null;
  if (report.message.messageType === "customer-feedback.case.attention-requested") {
    return {
      sourceTenantId,
      purpose: "attention",
      caseId: value("caseId"),
      attentionId: value("attentionId"),
      digestId: null,
    };
  }
  if (report.message.messageType === "customer-feedback.case.follow-up-requested") {
    return { sourceTenantId, purpose: "follow-up", caseId: value("caseId"), attentionId: null, digestId: null };
  }
  if (report.message.messageType === "customer-feedback.case.attention-digest") {
    return { sourceTenantId, purpose: "digest", caseId: null, attentionId: null, digestId: value("digestId") };
  }
  return null;
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
