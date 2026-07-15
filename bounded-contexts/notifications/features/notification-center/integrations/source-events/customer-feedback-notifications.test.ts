import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, it } from "vitest";
import { createCustomerFeedbackNotificationDeliveryOutcomeReporter } from "../../domain/customer-feedback-delivery";
import {
  mapFeedbackAttentionDigestToNotification,
  mapFeedbackAttentionToNotification,
  mapFeedbackFollowUpToNotification,
} from "./customer-feedback-notifications";

const transport = {
  id: "evt_1",
  tenantId: "tnt_customer",
  globalPosition: "1",
  trace: { traceId: "trace_1" },
  timing: { occurredAt: "2026-07-14T12:00:00.000Z" },
} as const;

describe("Customer Feedback notification contracts", () => {
  it("uses minimal attention and consented follow-up payloads", () => {
    const attention = mapFeedbackAttentionToNotification({
      ...transport,
      data: {
        caseId: "fbcase_01",
        attentionId: "attention_01",
        reason: "low-score",
        ruleVersion: "low-score-v1",
        rating: 1,
        priority: "urgent",
        ownerId: "usr_owner",
        dueAt: null,
        adminHref: "/support/customer-feedback/attention?caseId=fbcase_01",
      },
    } as never);
    const followUp = mapFeedbackFollowUpToNotification({
      ...transport,
      data: {
        caseId: "fbcase_01",
        consentVersion: "feedback-follow-up-v1",
        recipientAccountId: "acc_customer",
        channel: "web",
        templateVersion: 2,
      },
    } as never);

    expect(attention).toMatchObject({
      templateData: { caseId: "fbcase_01", ruleVersion: "low-score-v1" },
      channels: [{ channel: "web", recipient: { userId: "usr_owner" } }],
    });
    expect(followUp).toMatchObject({
      recipientAccountId: "acc_customer",
      templateVersion: 2,
      templateData: { caseId: "fbcase_01", purpose: "support follow-up" },
    });
    expect(JSON.stringify([attention, followUp])).not.toContain("comment");
  });

  it("maps one bounded digest per resolved recipient and keeps no-recipient groups out of the outbox", () => {
    const event = {
      ...transport,
      data: {
        digestId: "digest_01",
        windowStart: "2026-07-14T11:45:00.000Z",
        windowEnd: "2026-07-14T12:00:00.000Z",
        groupKey: "operator:usr_owner",
        teamKey: "support",
        recipientUserId: "usr_owner",
        capped: true,
        items: [
          {
            attentionId: "attention_01",
            caseId: "fbcase_01",
            priority: "urgent",
            reason: "sla-breach",
            adminHref: "/support/customer-feedback/attention?caseId=fbcase_01",
          },
        ],
      },
    };
    expect(mapFeedbackAttentionDigestToNotification(event as never)).toMatchObject({
      idempotencyKey: "notifications:customer-feedback:attention-digest:digest_01",
      templateData: { digestId: "digest_01", itemCount: 1, capped: true },
    });
    expect(
      mapFeedbackAttentionDigestToNotification({
        ...event,
        data: { ...event.data, recipientUserId: null },
      } as never),
    ).toBeNull();
  });

  it("publishes idempotent minimal delivery reports", async () => {
    const store = createInMemoryEventStore();
    const reporter = createCustomerFeedbackNotificationDeliveryOutcomeReporter(store.eventStore);
    const message = mapFeedbackAttentionToNotification({
      ...transport,
      data: {
        caseId: "fbcase_01",
        attentionId: "attention_01",
        reason: "low-score",
        ruleVersion: "low-score-v1",
        rating: 1,
        priority: "urgent",
        ownerId: "usr_owner",
        dueAt: null,
        adminHref: "/support/customer-feedback/attention",
      },
    } as never)!;
    const report = {
      deliveryId: "delivery_01",
      message,
      channel: "web",
      outcome: "retry-exhausted",
      attemptCount: 5,
      maxAttempts: 5,
      reportedAt: "2026-07-14T12:01:00.000Z",
    } as const;
    await reporter.reportNotificationDeliveryOutcome(report);
    await reporter.reportNotificationDeliveryOutcome(report);
    const events = await store.eventStore.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: "tnt_customer",
      eventType: "notifications.customer-feedback.delivery-reported",
      payload: {
        purpose: "attention",
        caseId: "fbcase_01",
        attentionId: "attention_01",
        outcome: "retry-exhausted",
      },
    });
    expect(JSON.stringify(events)).not.toContain(message.body);
  });
});
