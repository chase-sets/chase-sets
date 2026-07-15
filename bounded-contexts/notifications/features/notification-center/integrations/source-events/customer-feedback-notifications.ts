import { t } from "@chase-sets/localization";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import type { NotificationMessage, NotificationOutbox } from "@chase-sets/outbound-messaging";

const CUSTOMER_FEEDBACK_TEMPLATE_VERSION = 1;

type FeedbackAttentionRequestedEvent = TransportEvent &
  Readonly<{
    type: "customer-feedback.case.attention-requested";
    data: Readonly<{
      caseId: string;
      attentionId: string;
      reason: "low-score" | "reopened";
      ruleVersion: string;
      rating: number;
      priority: "low" | "normal" | "high" | "urgent";
      ownerId: string | null;
      dueAt: string | null;
      adminHref: string;
    }>;
  }>;

type FeedbackFollowUpRequestedEvent = TransportEvent &
  Readonly<{
    type: "customer-feedback.case.follow-up-requested";
    data: Readonly<{
      caseId: string;
      consentVersion: string;
      recipientAccountId?: string | null;
      channel?: "web" | "email" | "sms" | "rcs";
      templateVersion?: number;
    }>;
  }>;

type FeedbackAttentionDigestRequestedEvent = TransportEvent &
  Readonly<{
    type: "customer-feedback.attention.digest-requested";
    data: Readonly<{
      digestId: string;
      windowStart: string;
      windowEnd: string;
      groupKey: string;
      teamKey: string;
      recipientUserId: string | null;
      items: readonly Readonly<{
        attentionId: string;
        caseId: string;
        priority: "low" | "normal" | "high" | "urgent";
        reason: "low-score" | "reopened" | "sla-breach";
        adminHref: string;
      }>[];
      capped: boolean;
    }>;
  }>;

export function buildNotificationsCustomerFeedbackProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = "notifications-source-facts-outbox-projection",
): ProjectorHandlerMap {
  return {
    "customer-feedback.case.attention-requested": (event) =>
      projectAttentionRequested(outbox, event as FeedbackAttentionRequestedEvent, projectionName),
    "customer-feedback.case.follow-up-requested": (event) =>
      projectFollowUpRequested(outbox, event as FeedbackFollowUpRequestedEvent, projectionName),
    "customer-feedback.attention.digest-requested": (event) =>
      projectAttentionDigestRequested(outbox, event as FeedbackAttentionDigestRequestedEvent, projectionName),
  };
}

export function mapFeedbackAttentionToNotification(event: FeedbackAttentionRequestedEvent): NotificationMessage | null {
  if (!event.data.ownerId) return null;
  return {
    messageType: "customer-feedback.case.attention-requested",
    criticality: "operational",
    category: "operational",
    title: t("notifications.intents.customerFeedbackAttention.title"),
    body: t("notifications.intents.customerFeedbackAttention.body", {
      priority: event.data.priority,
      rating: event.data.rating,
    }),
    actionHref: event.data.adminHref,
    templateId: "customer_feedback_attention",
    templateVersion: CUSTOMER_FEEDBACK_TEMPLATE_VERSION,
    locale: "en",
    templateData: {
      sourceTenantId: event.tenantId,
      caseId: event.data.caseId,
      attentionId: event.data.attentionId,
      reason: event.data.reason,
      ruleVersion: event.data.ruleVersion,
      priority: event.data.priority,
      rating: event.data.rating,
      actionHref: event.data.adminHref,
    },
    channels: [
      {
        channel: "web",
        recipient: { userId: event.data.ownerId as UserId },
        actionHref: event.data.adminHref,
      },
    ],
    idempotencyKey: `notifications:customer-feedback:attention:${event.data.attentionId}:${event.data.ownerId}`,
    correlationId: event.trace.traceId ?? event.id,
    actor: { userId: null },
  };
}

export function mapFeedbackFollowUpToNotification(event: FeedbackFollowUpRequestedEvent): NotificationMessage | null {
  const recipientAccountId = event.data.recipientAccountId?.trim();
  if (!recipientAccountId) return null;
  return {
    messageType: "customer-feedback.case.follow-up-requested",
    criticality: "operational",
    category: "operational",
    recipientAccountId: recipientAccountId as AccountId,
    title: t("notifications.intents.customerFeedbackFollowUp.title"),
    body: t("notifications.intents.customerFeedbackFollowUp.body"),
    templateId: "customer_feedback_follow_up",
    templateVersion: event.data.templateVersion ?? CUSTOMER_FEEDBACK_TEMPLATE_VERSION,
    locale: "en",
    templateData: {
      sourceTenantId: event.tenantId,
      caseId: event.data.caseId,
      consentVersion: event.data.consentVersion,
      purpose: "support follow-up",
    },
    channels: [
      {
        channel: "web",
        recipient: { accountId: recipientAccountId as AccountId },
      },
    ],
    idempotencyKey: `notifications:customer-feedback:follow-up:${event.data.caseId}:${event.data.consentVersion}`,
    correlationId: event.trace.traceId ?? event.id,
    actor: { userId: null },
  };
}

export function mapFeedbackAttentionDigestToNotification(
  event: FeedbackAttentionDigestRequestedEvent,
): NotificationMessage | null {
  if (!event.data.recipientUserId || event.data.items.length === 0) return null;
  return {
    messageType: "customer-feedback.case.attention-digest",
    criticality: "operational",
    category: "operational",
    title: t("notifications.intents.customerFeedbackDigest.title"),
    body: t("notifications.intents.customerFeedbackDigest.body", { count: event.data.items.length }),
    actionHref: "/support/customer-feedback/attention",
    templateId: "customer_feedback_attention_digest",
    templateVersion: CUSTOMER_FEEDBACK_TEMPLATE_VERSION,
    locale: "en",
    templateData: {
      sourceTenantId: event.tenantId,
      digestId: event.data.digestId,
      windowStart: new Date(event.data.windowStart).toISOString(),
      windowEnd: new Date(event.data.windowEnd).toISOString(),
      itemCount: event.data.items.length,
      capped: event.data.capped,
      groupKey: event.data.groupKey,
    },
    channels: [
      {
        channel: "web",
        recipient: { userId: event.data.recipientUserId as UserId },
        actionHref: "/support/customer-feedback/attention",
      },
    ],
    idempotencyKey: `notifications:customer-feedback:attention-digest:${event.data.digestId}`,
    correlationId: event.trace.traceId ?? event.id,
    actor: { userId: null },
  };
}

async function projectAttentionRequested(
  outbox: NotificationOutbox,
  event: FeedbackAttentionRequestedEvent,
  projectionName: string,
) {
  const message = mapFeedbackAttentionToNotification(event);
  if (message) await outbox.enqueueNotification({ message, source: sourceFromEvent(event, projectionName) });
}

async function projectFollowUpRequested(
  outbox: NotificationOutbox,
  event: FeedbackFollowUpRequestedEvent,
  projectionName: string,
) {
  const message = mapFeedbackFollowUpToNotification(event);
  if (message) await outbox.enqueueNotification({ message, source: sourceFromEvent(event, projectionName) });
}

async function projectAttentionDigestRequested(
  outbox: NotificationOutbox,
  event: FeedbackAttentionDigestRequestedEvent,
  projectionName: string,
) {
  const message = mapFeedbackAttentionDigestToNotification(event);
  if (message) await outbox.enqueueNotification({ message, source: sourceFromEvent(event, projectionName) });
}

function sourceFromEvent(event: TransportEvent, projectionName: string) {
  return {
    sourceEventId: event.id,
    sourceGlobalPosition: event.globalPosition,
    projectionName,
    occurredAt: event.timing.occurredAt,
  };
}
