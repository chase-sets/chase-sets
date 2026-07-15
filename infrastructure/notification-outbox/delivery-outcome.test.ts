import type { ClaimedNotificationDelivery, NotificationOutboxStore } from "@chase-sets/outbound-messaging";
import { describe, expect, it, vi } from "vitest";
import { createNotificationOutboxDispatcher } from "./index";

function claimed(attemptCount = 1, maxAttempts = 2): ClaimedNotificationDelivery {
  return {
    outboxId: "1",
    deliveryId: "delivery_1",
    status: "sending",
    attemptCount,
    maxAttempts,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    nextAttemptAt: "2026-07-14T00:00:00.000Z",
    lastError: null,
    source: {
      sourceEventId: "evt_1",
      sourceGlobalPosition: "1",
      projectionName: "notifications-source-facts-outbox-projection",
      occurredAt: "2026-07-14T00:00:00.000Z",
    },
    message: {
      messageType: "customer-feedback.case.follow-up-requested",
      criticality: "operational",
      recipientAccountId: "acc_customer" as never,
      title: "Support follow-up",
      body: "Support follow-up",
      templateId: "customer_feedback_follow_up",
      templateVersion: 1,
      locale: "en",
      templateData: { caseId: "fbcase_01", consentVersion: "feedback-follow-up-v1" },
      channels: [{ channel: "web", recipient: { accountId: "acc_customer" as never } }],
      idempotencyKey: "follow-up-1",
      correlationId: "trace-1",
      actor: { userId: null },
    },
    channel: { channel: "web", recipient: { accountId: "acc_customer" as never } },
  };
}

function outbox(delivery: ClaimedNotificationDelivery) {
  return {
    enqueueNotification: vi.fn(),
    claimPendingNotificationDeliveries: vi.fn(async () => [delivery]),
    renewClaimedNotificationDelivery: vi.fn(async () => true),
    markNotificationDeliverySent: vi.fn(async () => undefined),
    markNotificationDeliveryFailed: vi.fn(async () => undefined),
  } satisfies NotificationOutboxStore;
}

describe("notification delivery policy outcomes", () => {
  it("reports send-time policy suppression without invoking a channel adapter", async () => {
    const store = outbox(claimed());
    const send = vi.fn();
    const report = vi.fn(async () => undefined);
    const dispatcher = createNotificationOutboxDispatcher({
      outbox: store,
      adapters: [{ channel: "web", sendNotificationChannel: send }],
      claimOwnerId: "worker-1",
      preferenceResolver: { listPreferences: vi.fn(async () => []) },
      deliveryGuard: { evaluateNotificationDelivery: vi.fn(async () => ({ allowed: false, reason: "revoked" })) },
      deliveryOutcomeReporter: { reportNotificationDeliveryOutcome: report },
    });

    await dispatcher.runOnce();
    expect(send).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "suppressed" }));
    expect(store.markNotificationDeliverySent).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: expect.objectContaining({ providerName: "delivery-policy" }) }),
    );
  });

  it("distinguishes a retryable failure from retry exhaustion", async () => {
    for (const [attemptCount, expected] of [
      [1, "failed"],
      [2, "retry-exhausted"],
    ] as const) {
      const store = outbox(claimed(attemptCount, 2));
      const report = vi.fn(async () => undefined);
      const dispatcher = createNotificationOutboxDispatcher({
        outbox: store,
        adapters: [
          {
            channel: "web",
            sendNotificationChannel: vi.fn(async () => {
              throw new Error("provider unavailable");
            }),
          },
        ],
        claimOwnerId: "worker-1",
        preferenceResolver: { listPreferences: vi.fn(async () => []) },
        deliveryOutcomeReporter: { reportNotificationDeliveryOutcome: report },
        now: () => new Date("2026-07-14T00:00:00.000Z"),
      });
      await dispatcher.runOnce();
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ outcome: expected, attemptCount }));
      expect(store.markNotificationDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({ retryAt: expected === "failed" ? expect.any(String) : null }),
      );
    }
  });
});
