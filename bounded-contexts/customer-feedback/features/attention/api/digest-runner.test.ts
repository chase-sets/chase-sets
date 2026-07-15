import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, it, vi } from "vitest";
import { createFeedbackAttentionDigestRunner } from "./digest-runner";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_system" as never, forAccountId: "acc_platform" as never },
};

function item(attentionId: string, ownerId: string | null, priority: "urgent" | "high") {
  return {
    attentionId,
    caseId: `fbcase_${attentionId}`,
    state: "active",
    reason: "low-score",
    ruleVersion: "low-score-v1",
    rating: priority === "urgent" ? 1 : 2,
    priority,
    ownerId,
    openedAt: "2026-07-14T11:00:00.000Z",
    triagedAt: null,
    dueAt: null,
    triageDueAt: "2026-07-14T12:00:00.000Z",
    closedAt: null,
    deliveryStatus: "pending",
    deliveryReference: null,
    deliveryReportedAt: null,
    followUpDeliveryStatus: "not-requested",
    followUpChannel: null,
  } as const;
}

describe("feedback attention digest runner", () => {
  it("uses aligned windows, caps each recipient group independently, and dedupes retries", async () => {
    const store = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({
        rows: [
          item("assigned-1", "usr_owner", "urgent"),
          item("assigned-2", "usr_owner", "high"),
          item("team-1", null, "high"),
        ],
      })),
    };
    const run = createFeedbackAttentionDigestRunner({ db: db as never, eventStore: store.eventStore });
    const input = {
      now: "2026-07-14T12:07:00.000Z",
      windowMinutes: 15,
      maxItemsPerGroup: 1,
      teamRecipientUserIds: ["usr_team"],
    } as const;

    await expect(run(input, context)).resolves.toMatchObject({
      windowStart: "2026-07-14T11:45:00.000Z",
      windowEnd: "2026-07-14T12:00:00.000Z",
      groupsRequested: 2,
      itemCount: 2,
    });
    await expect(run(input, context)).resolves.toMatchObject({ groupsRequested: 0, groupsAlreadyRequested: 2 });

    const events = await store.eventStore.readAll();
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.eventType === "customer-feedback.attention.digest-requested")).toBe(true);
    expect(events.map((event) => event.payload.capped).sort()).toEqual([false, true]);
    expect(JSON.stringify(events)).not.toContain("comment");
  });
});
