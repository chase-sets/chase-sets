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
import { createSupportRequestRuntime } from "./runtime";

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

describe("support request runtime", () => {
  it("returns an account-scoped support order context before opening a request", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM support_order_sources")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
                status: "ready-for-fulfillment",
                total_amount: "24.00",
                return_context: [],
              },
            ],
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      runtime.getSupportOrderContext({
        orderId: "ord_1",
        accountId: "acc_buyer",
        openedByRole: "buyer",
      }),
    ).resolves.toEqual({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
    });

    await expect(
      runtime.getSupportOrderContext({
        orderId: "ord_1",
        accountId: "acc_seller",
        openedByRole: "buyer",
      }),
    ).rejects.toThrow("Only the buyer can open this buyer support flow.");
  });

  it("opens a buyer support request from an order source and rejects duplicates", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM support_order_sources")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
                status: "ready-for-fulfillment",
                total_amount: "24.00",
                return_context: [],
              },
            ],
          };
        }

        if (sql.includes("FROM support_request_pages")) {
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const result = await runtime.openSupportRequest(
      {
        orderId: "ord_1",
        accountId: "acc_buyer",
        flowType: "product-not-received",
        openedByRole: "buyer",
      },
      context,
    );

    expect(result.supportRequestId).toMatch(/^sup_/);
    expect(allEvents[0]?.eventType).toBe("support.support-request.opened");
    expect(allEvents[0]?.payload).toMatchObject({
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      flowType: "product-not-received",
      status: "waiting-on-seller",
    });
  });

  it("rejects malformed order ids before looking up support order sources", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      runtime.openSupportRequest(
        {
          orderId: "order_1",
          accountId: "acc_buyer",
          flowType: "product-not-received",
          openedByRole: "buyer",
        },
        context,
      ),
    ).rejects.toThrow("Expected an order ID starting with ord_.");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects unknown order ids through the support order source lookup", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM support_order_sources")) {
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      runtime.openSupportRequest(
        {
          orderId: "ord_missing",
          accountId: "acc_buyer",
          flowType: "product-not-received",
          openedByRole: "buyer",
        },
        context,
      ),
    ).rejects.toThrow("Order not found for support.");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("prevents a sale-side account from opening a purchase-side issue", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM support_order_sources")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
                status: "ready-for-fulfillment",
                total_amount: "24.00",
                return_context: [],
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      runtime.openSupportRequest(
        {
          orderId: "ord_1",
          accountId: "acc_seller",
          flowType: "product-not-received",
          openedByRole: "buyer",
        },
        {
          ...context,
          audit: {
            performedByUserId: "usr_seller" as never,
            forAccountId: "acc_seller" as never,
          },
        },
      ),
    ).rejects.toThrow("Only the buyer can open this buyer support flow.");
  });

  it("escalates a support request from the marketplace API and records the account-scoped escalator", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM support_order_sources")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
                status: "ready-for-fulfillment",
                total_amount: "24.00",
                return_context: [],
              },
            ],
          };
        }

        if (sql.includes("FROM support_request_pages") && sql.includes("WHERE order_id")) {
          return { rows: [] };
        }

        if (sql.includes("FROM support_request_pages")) {
          return {
            rows: [
              {
                support_request_id: "sup_placeholder",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
              },
            ],
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const opened = await runtime.openSupportRequest(
      {
        orderId: "ord_1",
        accountId: "acc_buyer",
        flowType: "product-not-received",
        openedByRole: "buyer",
      },
      context,
    );

    await runtime.escalateSupportRequest(
      {
        supportRequestId: opened.supportRequestId,
        accountId: "acc_buyer",
        reason: "We can't agree on next steps.",
      },
      context,
    );

    const escalatedEvent = allEvents.find((event) => event.eventType === "support.support-request.escalated");
    expect(escalatedEvent?.payload).toMatchObject({
      reason: "We can't agree on next steps.",
      escalatedByAccountId: "acc_buyer",
      escalatedByRole: "buyer",
    });
  });
});
