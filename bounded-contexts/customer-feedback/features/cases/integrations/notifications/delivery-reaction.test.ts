import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, it, vi } from "vitest";
import { buildNotificationDeliveryReactionHandlers } from "./delivery-reaction";

function event(data: Record<string, unknown>) {
  return {
    id: `evt_${data.purpose}`,
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_notifications", forAccountId: "acc_platform" },
    trace: { traceId: "trace_1" },
    data: {
      caseId: null,
      attentionId: null,
      digestId: null,
      deliveryReference: "delivery_1",
      outcome: "sent",
      channel: "web",
      templateVersion: 1,
      reportedAt: "2026-07-14T12:01:00.000Z",
      ...data,
    },
  } as never;
}

describe("Notifications delivery report reaction", () => {
  it("records attention and follow-up outcomes through authorized idempotent case commands", async () => {
    const store = createInMemoryEventStore();
    const execute = vi.fn(async () => undefined);
    const handler = buildNotificationDeliveryReactionHandlers(execute as never, store.eventStore)[
      "notifications.customer-feedback.delivery-reported"
    ]!;

    await handler(event({ purpose: "attention", caseId: "fbcase_01", attentionId: "attention_01" }));
    await handler(event({ purpose: "follow-up", caseId: "fbcase_01", outcome: "retry-exhausted" }));

    expect(execute).toHaveBeenNthCalledWith(
      1,
      "fbcase_01",
      expect.objectContaining({
        type: "RecordFeedbackCaseAttentionDeliveryOutcome",
        attentionId: "attention_01",
        actor: { actorId: "notifications.delivery-reporter", authority: "notify-feedback-cases" },
      }),
      expect.any(Object),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "fbcase_01",
      expect.objectContaining({ type: "RecordFeedbackCaseFollowUpDeliveryOutcome", outcome: "retry-exhausted" }),
      expect.any(Object),
    );
  });

  it("turns digest delivery reports into replayable Customer Feedback facts", async () => {
    const store = createInMemoryEventStore();
    const handler = buildNotificationDeliveryReactionHandlers(vi.fn() as never, store.eventStore)[
      "notifications.customer-feedback.delivery-reported"
    ]!;
    const report = event({ purpose: "digest", digestId: "digest_01", outcome: "suppressed" });
    await handler(report);
    await handler(report);
    const events = await store.eventStore.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "customer-feedback.attention.digest-delivery-outcome-recorded",
      payload: { digestId: "digest_01", outcome: "suppressed" },
    });
  });
});
