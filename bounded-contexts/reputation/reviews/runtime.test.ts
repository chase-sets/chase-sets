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
import { createReputationReviewRuntime } from "./runtime";

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
          correlationId: input.context.trace?.correlationId,
          causationId: input.context.trace?.causationId,
          commandId: input.context.trace?.commandId,
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

  return { eventStore };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) =>
      checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
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

describe("reputation review runtime", () => {
  it("creates buyer and seller review eligibility when the same order is delivered", async () => {
    const inserts: unknown[][] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return { rows: [{ order_id: "ord_1" }] };
        }

        if (
          sql.includes("FROM ordering_order_pages") &&
          sql.includes("buyer_account_id") &&
          sql.includes("seller_account_id")
        ) {
          return {
            rows: [
              {
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
              },
            ],
          };
        }

        if (sql.includes("INSERT INTO reputation_review_eligibility_pages")) {
          inserts.push(params ?? []);
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createReputationReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await eventStore.appendToStream({
      streamId: "fulfillment.shipment-shp_1",
      events: [
        {
          eventType: "fulfillment.shipment.delivered",
          payload: {
            shipmentId: "shp_1",
            deliveredAt: "2026-04-02T00:00:00.000Z",
          },
        },
      ],
      context,
    });

    const result = await runtime.projectors[1]?.runOnce();

    expect(result?.processed).toBe(1);
    expect(inserts).toEqual([
      [
        "ord_1",
        "acc_buyer",
        "acc_seller",
        "buyer",
        "2026-04-02T00:00:00.000Z",
      ],
      [
        "ord_1",
        "acc_seller",
        "acc_buyer",
        "seller",
        "2026-04-02T00:00:00.000Z",
      ],
    ]);
  });
});
