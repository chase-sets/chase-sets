import { describe, expect, it, vi } from "vitest";
import { createFeedbackNotificationDeliveryGuard } from "./delivery-authorization";

function delivery() {
  return {
    deliveryId: "delivery_1",
    outboxId: "1",
    source: {},
    status: "sending",
    attemptCount: 1,
    maxAttempts: 5,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    nextAttemptAt: "2026-07-14T00:00:00.000Z",
    lastError: null,
    message: {
      messageType: "customer-feedback.case.follow-up-requested",
      criticality: "operational",
      recipientAccountId: "acc_customer",
      title: "Support follow-up",
      body: "Support follow-up",
      templateId: "customer_feedback_follow_up",
      templateVersion: 1,
      locale: "en",
      templateData: { caseId: "fbcase_01", consentVersion: "feedback-follow-up-v1", purpose: "support follow-up" },
      channels: [{ channel: "web", recipient: { accountId: "acc_customer" } }],
      idempotencyKey: "follow-up-1",
      correlationId: "trace-1",
      actor: { userId: null },
    },
    channel: { channel: "web", recipient: { accountId: "acc_customer" } },
  } as const;
}

function feedbackCase() {
  return {
    consent: { status: "granted", version: "feedback-follow-up-v1", grantedAt: "2026-07-14T00:00:00.000Z" },
    disposition: null,
    followUpStatus: "requested",
    followUpChannel: "web",
    followUpTemplateVersion: 1,
    sourceResponse: { subjectAccountId: "acc_customer" },
  };
}

describe("send-time feedback follow-up authorization", () => {
  it("allows the current consented request and suppresses consent, recipient, and disposition changes", async () => {
    const current = feedbackCase();
    const load = vi.fn(async () => current as never);
    const guard = createFeedbackNotificationDeliveryGuard(load);
    await expect(guard.evaluateNotificationDelivery(delivery() as never)).resolves.toEqual({ allowed: true });

    current.consent.status = "withdrawn";
    await expect(guard.evaluateNotificationDelivery(delivery() as never)).resolves.toMatchObject({ allowed: false });
    current.consent.status = "granted";
    current.sourceResponse.subjectAccountId = "acc_other";
    await expect(guard.evaluateNotificationDelivery(delivery() as never)).resolves.toMatchObject({
      allowed: false,
      reason: "follow-up-recipient-mismatch",
    });
    current.sourceResponse.subjectAccountId = "acc_customer";
    current.disposition = "spam" as never;
    await expect(guard.evaluateNotificationDelivery(delivery() as never)).resolves.toMatchObject({
      allowed: false,
      reason: "follow-up-disposition-inapplicable",
    });
  });
});
