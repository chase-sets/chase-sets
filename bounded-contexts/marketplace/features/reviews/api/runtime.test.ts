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
import { createReviewRuntime } from "./runtime";

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
    forAccountId: "acc_buyer" as never,
  },
};

describe("marketplace review runtime", () => {
  it("creates buyer and seller review eligibility from delivered local shipment and order sources", async () => {
    const inserts: (readonly unknown[])[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("MIN(delivered_at)")) {
          return { rows: [{ delivered_at: "2026-04-02T00:00:00.000Z" }] };
        }

        if (sql.includes("FROM marketplace_review_shipment_sources")) {
          return { rows: [{ order_id: "ord_1" }] };
        }

        if (sql.includes("FROM marketplace_review_order_sources")) {
          return {
            rows: [
              {
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
              },
            ],
          };
        }

        if (sql.includes("FROM marketplace_review_support_request_sources")) {
          return { rows: [] };
        }

        if (sql.includes("INSERT INTO marketplace_review_eligibility_pages")) {
          inserts.push(params ?? []);
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await runtime.recordDeliveredShipmentReviewEligibility({
      shipmentId: "shp_1",
      deliveredAt: "2026-04-02T00:00:00.000Z",
    });
    expect(inserts).toEqual([
      ["ord_1", "acc_buyer", "acc_seller", "buyer", null, "2026-04-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z"],
      ["ord_1", "acc_seller", "acc_buyer", "seller", null, "2026-04-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z"],
    ]);
  });

  it("submits a seller-to-buyer review from seller eligibility", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                author_account_id: "acc_seller",
                subject_account_id: "acc_buyer",
                author_role: "seller",
                eligible_at: "2026-04-02T00:00:00.000Z",
              },
            ],
          };
        }

        if (sql.includes("FROM marketplace_review_pages")) {
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const result = await runtime.submitReview(
      {
        orderId: "ord_1",
        authorAccountId: "acc_seller",
        subjectAccountId: "acc_buyer",
        rating: 4,
        feedback: "Prompt payment and clear communication.",
      },
      {
        ...context,
        audit: {
          performedByUserId: "usr_seller" as never,
          forAccountId: "acc_seller" as never,
        },
      },
    );

    expect(result.reviewId).toMatch(/^rev_/);
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]?.eventType).toBe("marketplace.review.submitted");
    expect(allEvents[0]?.payload).toMatchObject({
      orderId: "ord_1",
      authorAccountId: "acc_seller",
      subjectAccountId: "acc_buyer",
      authorRole: "seller",
      rating: 4,
      feedback: "Prompt payment and clear communication.",
      resolutionContext: null,
    });
  });

  it("carries the refund resolution marker from the eligibility row onto the submitted review", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                author_account_id: "acc_buyer",
                subject_account_id: "acc_seller",
                author_role: "buyer",
                resolution_context: "resolved-via-refund",
                eligible_at: "2026-04-02T00:00:00.000Z",
              },
            ],
          };
        }

        if (sql.includes("FROM marketplace_review_pages")) {
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await runtime.submitReview(
      {
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        rating: 1,
        feedback: "Card arrived misdescribed; refunded after support review.",
      },
      context,
    );

    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]?.payload).toMatchObject({
      authorRole: "buyer",
      resolutionContext: "resolved-via-refund",
    });
  });
});
