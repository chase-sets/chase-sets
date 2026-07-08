import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPlatformFeedbackRuntime } from "./runtime";

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { allEvents, eventStore };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

describe("platform feedback runtime", () => {
  it("rejects duplicate feedback for the same account, workflow, and related entity", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM experience_platform_feedback_pages") && sql.includes("related_entity_key = $3")) {
          return { rows: [{ feedback_id: "pfb_existing" }] };
        }

        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createPlatformFeedbackRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      runtime.submitPlatformFeedback(
        {
          userId: "usr_test",
          accountId: "acc_test",
          rating: 5,
          topic: "checkout-payment",
          followUpConsent: false,
          workflow: "checkout-payment",
          sourceRoutePath: "/account/payments/pay_test",
          relatedEntities: [{ type: "payment", id: "pay_test" }],
        },
        context,
      ),
    ).rejects.toThrow("Platform feedback has already been submitted for this workflow.");
    expect(allEvents).toHaveLength(0);
  });

  it("checks the 30 day duplicate window when no related entity exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    const queryParams: (readonly unknown[])[] = [];
    const db = {
      query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
        queryParams.push(params ?? []);
        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createPlatformFeedbackRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    try {
      await runtime.submitPlatformFeedback(
        {
          userId: "usr_test",
          accountId: "acc_test",
          rating: 4,
          topic: "ease-of-use",
          followUpConsent: true,
          workflow: "listing-publish",
          sourceRoutePath: "/account/listings",
        },
        context,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(queryParams[0]).toEqual(["acc_test", "listing-publish", "2026-04-07T12:00:00.000Z"]);
    expect(allEvents[0]?.streamId).toMatch(/^platform-operations\.platform-feedback-/);
    expect(allEvents[0]?.eventType).toBe("experience.platform-feedback.submitted");
  });

  it("snoozes dismissed prompts for seven days and uses snooze for eligibility", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    let snoozed = false;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM experience_platform_feedback_prompt_pages") && snoozed) {
          return { rows: [{ prompt_id: "pfp_acc_test_inventory-adjust_inventoryItem-inv_test" }] };
        }

        return { rows: [] };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createPlatformFeedbackRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    try {
      const result = await runtime.dismissPrompt(
        {
          userId: "usr_test",
          accountId: "acc_test",
          workflow: "inventory-adjust",
          sourceRoutePath: "/account/inventory/inv_test",
          relatedEntities: [{ type: "inventoryItem", id: "inv_test" }],
        },
        context,
      );
      snoozed = true;

      expect(result.snoozedUntil).toBe("2026-05-14T12:00:00.000Z");
      await expect(
        runtime.getPromptEligibility({
          accountId: "acc_test",
          workflow: "inventory-adjust",
          relatedEntities: [{ type: "inventoryItem", id: "inv_test" }],
        }),
      ).resolves.toEqual({ shouldPrompt: false, reason: "snoozed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits an archive event after reviewed feedback", async () => {
    const rowsByFeedbackId = new Map<string, { feedback_id: string; status: string }>();
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("FROM experience_platform_feedback_pages") && sql.includes("feedback_id = $1")) {
          const feedbackId = String(params?.[0] ?? "");
          return { rows: rowsByFeedbackId.get(feedbackId) ? [rowsByFeedbackId.get(feedbackId)] : [] };
        }

        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createPlatformFeedbackRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const submitted = await runtime.submitPlatformFeedback(
      {
        userId: "usr_test",
        accountId: "acc_test",
        rating: 4,
        topic: "pricing-fees",
        followUpConsent: true,
        workflow: "listing-publish",
        sourceRoutePath: "/account/listings/lst_test",
        relatedEntities: [{ type: "listing", id: "lst_test" }],
      },
      context,
    );
    rowsByFeedbackId.set(submitted.feedbackId, { feedback_id: submitted.feedbackId, status: "new" });

    await runtime.markReviewed(submitted.feedbackId, "usr_admin", context);
    rowsByFeedbackId.set(submitted.feedbackId, { feedback_id: submitted.feedbackId, status: "reviewed" });
    const archived = await runtime.archive(submitted.feedbackId, "usr_admin", context);

    expect(archived.version).toBe(3);
    expect([...new Set(allEvents.map((event) => event.streamId))]).toEqual([
      `platform-operations.platform-feedback-${submitted.feedbackId}`,
    ]);
    expect(allEvents.map((event) => event.eventType)).toEqual([
      "experience.platform-feedback.submitted",
      "experience.platform-feedback.reviewed",
      "experience.platform-feedback.archived",
    ]);
  });
});
