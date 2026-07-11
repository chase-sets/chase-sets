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

  describe("deadline sweep", () => {
    const orderSourceRow = {
      order_id: "ord_1",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
      status: "ready-for-fulfillment",
      total_amount: "24.00",
      return_context: [],
    };

    it("auto-resolves a seller-silence candidate with a system actor and is idempotent under a repeated pass", async () => {
      let pendingId = "";
      let openedAtIso = "";
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM support_order_sources")) {
            return { rows: [orderSourceRow] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("WHERE order_id")) {
            return { rows: [] };
          }
          if (sql.includes("status = 'waiting-on-seller'") && sql.includes("<= $1::timestamptz")) {
            return pendingId
              ? { rows: [{ support_request_id: pendingId, flow_type: "product-not-received", opened_at: openedAtIso }] }
              : { rows: [] };
          }
          if (sql.includes("FROM support_request_pages")) {
            return { rows: [] };
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received", openedByRole: "buyer" },
        context,
      );
      pendingId = opened.supportRequestId;
      const openedEvent = allEvents.find((event) => event.eventType === "support.support-request.opened");
      const openedPayload = openedEvent?.payload as { openedAt: string; sellerResponseDueAt: string };
      openedAtIso = openedPayload.openedAt;
      const dueAt = openedPayload.sellerResponseDueAt;

      const result = await runtime.sweepSupportRequestDeadlines({ now: dueAt }, context);

      expect(result).toMatchObject({ autoResolved: 1, fallbackEscalated: 0, escalated: 0 });
      const resolvedEvent = allEvents.find((event) => event.eventType === "support.support-request.resolved");
      expect(resolvedEvent?.payload).toMatchObject({
        resolution: {
          resolutionType: "full-refund",
          resolvedByAccountId: null,
          resolvedByRole: null,
        },
        autoCloseDueAt: new Date(Date.parse(dueAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      // A second, overlapping sweep pass sees the same stale read-model
      // candidate, but the aggregate is already resolved: the command
      // handler no-ops instead of double-resolving or throwing.
      const secondPass = await runtime.sweepSupportRequestDeadlines({ now: dueAt }, context);
      expect(secondPass).toMatchObject({ autoResolved: 0, fallbackEscalated: 0 });
      expect(allEvents.filter((event) => event.eventType === "support.support-request.resolved")).toHaveLength(1);
    });

    it("escalates a seller-silence candidate whose default resolution needs a computed amount", async () => {
      let pendingId = "";
      let openedAtIso = "";
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM support_order_sources")) {
            return { rows: [orderSourceRow] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("WHERE order_id")) {
            return { rows: [] };
          }
          if (sql.includes("status = 'waiting-on-seller'") && sql.includes("<= $1::timestamptz")) {
            return pendingId
              ? { rows: [{ support_request_id: pendingId, flow_type: "missing-products", opened_at: openedAtIso }] }
              : { rows: [] };
          }
          if (sql.includes("FROM support_request_pages")) {
            return { rows: [] };
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "missing-products", openedByRole: "buyer" },
        context,
      );
      pendingId = opened.supportRequestId;
      const openedEvent = allEvents.find((event) => event.eventType === "support.support-request.opened");
      const openedPayload = openedEvent?.payload as { openedAt: string; sellerResponseDueAt: string };
      openedAtIso = openedPayload.openedAt;

      const result = await runtime.sweepSupportRequestDeadlines({ now: openedPayload.sellerResponseDueAt }, context);

      expect(result).toMatchObject({ autoResolved: 0, fallbackEscalated: 1 });
      expect(allEvents.some((event) => event.eventType === "support.support-request.resolved")).toBe(false);
      const escalatedEvent = allEvents.find((event) => event.eventType === "support.support-request.escalated");
      expect(escalatedEvent?.payload).toMatchObject({
        reason: "Support deadline reached; this flow requires support to determine the remedy.",
        escalatedByAccountId: null,
        escalatedByRole: null,
      });
    });

    it("escalates a contested case past its deadline instead of auto-resolving it", async () => {
      let pendingId = "";
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM support_order_sources")) {
            return { rows: [orderSourceRow] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("WHERE order_id")) {
            return { rows: [] };
          }
          if (sql.includes("status NOT IN ('waiting-on-seller', 'ready-for-support'")) {
            return pendingId ? { rows: [{ support_request_id: pendingId }] } : { rows: [] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("buyer_account_id = $2")) {
            // requireMutableSupportRequest's existence check before recordResponse.
            return pendingId ? { rows: [{ support_request_id: pendingId }] } : { rows: [] };
          }
          if (sql.includes("FROM support_request_pages")) {
            return { rows: [] };
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-as-described", openedByRole: "buyer" },
        context,
      );
      pendingId = opened.supportRequestId;
      await runtime.recordResponse(
        {
          supportRequestId: opened.supportRequestId,
          accountId: "acc_seller",
          submittedByRole: "seller",
          responseType: "challenge-with-evidence",
          summary: "Photos show the item matches the listing.",
        },
        context,
      );

      const result = await runtime.sweepSupportRequestDeadlines({ now: new Date().toISOString() }, context);

      expect(result).toMatchObject({ escalated: 1, autoResolved: 0, fallbackEscalated: 0 });
      const escalatedEvent = allEvents.find((event) => event.eventType === "support.support-request.escalated");
      expect(escalatedEvent?.payload).toMatchObject({
        reason: "Support deadline reached.",
        escalatedByAccountId: null,
        escalatedByRole: null,
      });
    });

    it("emits response and support-review reminders once their halfway/approaching thresholds are reached", async () => {
      let responseReminderPendingId = "";
      let reviewReminderPendingId = "";
      let responseOpenedAtIso = "";
      let reviewDueAtIso = "";
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM support_order_sources")) {
            return { rows: [orderSourceRow] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("WHERE order_id")) {
            return { rows: [] };
          }
          if (sql.includes("seller_response_reminder_sent_at IS NULL")) {
            return responseReminderPendingId
              ? {
                  rows: [
                    {
                      support_request_id: responseReminderPendingId,
                      flow_type: "product-not-received",
                      opened_at: responseOpenedAtIso,
                    },
                  ],
                }
              : { rows: [] };
          }
          if (sql.includes("support_review_reminder_sent_at IS NULL")) {
            return reviewReminderPendingId
              ? {
                  rows: [
                    {
                      support_request_id: reviewReminderPendingId,
                      flow_type: "authenticity-concern",
                      support_review_due_at: reviewDueAtIso,
                    },
                  ],
                }
              : { rows: [] };
          }
          if (sql.includes("FROM support_request_pages")) {
            return { rows: [] };
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

      const responseCase = await runtime.openSupportRequest(
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received", openedByRole: "buyer" },
        context,
      );
      const reviewCase = await runtime.openSupportRequest(
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "authenticity-concern", openedByRole: "buyer" },
        context,
      );
      responseReminderPendingId = responseCase.supportRequestId;
      reviewReminderPendingId = reviewCase.supportRequestId;
      const responseOpenedEvent = allEvents.find(
        (event) =>
          event.eventType === "support.support-request.opened" &&
          event.streamId.includes(responseCase.supportRequestId),
      );
      const reviewOpenedEvent = allEvents.find(
        (event) =>
          event.eventType === "support.support-request.opened" && event.streamId.includes(reviewCase.supportRequestId),
      );
      const responsePayload = responseOpenedEvent?.payload as { openedAt: string; sellerResponseDueAt: string };
      const reviewPayload = reviewOpenedEvent?.payload as { supportReviewDueAt: string };
      responseOpenedAtIso = responsePayload.openedAt;
      // product-not-received: sellerResponseHours = 48, so the halfway point is 24h after opening.
      const halfwayAt = new Date(Date.parse(responseOpenedAtIso) + 24 * 60 * 60 * 1000).toISOString();
      reviewDueAtIso = reviewPayload.supportReviewDueAt;
      // authenticity-concern: supportReviewHours = 12, so "approaching" (75% elapsed) is 9h after opening,
      // i.e. 3h before the due date.
      const approachingAt = new Date(Date.parse(reviewDueAtIso) - 3 * 60 * 60 * 1000).toISOString();

      const result = await runtime.sweepSupportRequestDeadlines(
        { now: Date.parse(halfwayAt) > Date.parse(approachingAt) ? halfwayAt : approachingAt },
        context,
      );
      // Run again at whichever threshold comes later so both reminders have fired.
      const finalResult = await runtime.sweepSupportRequestDeadlines(
        { now: Date.parse(halfwayAt) > Date.parse(approachingAt) ? approachingAt : halfwayAt },
        context,
      );

      expect(result.responseRemindersEmitted + finalResult.responseRemindersEmitted).toBe(1);
      expect(result.reviewRemindersEmitted + finalResult.reviewRemindersEmitted).toBe(1);
      expect(allEvents.some((event) => event.eventType === "support.support-request.response-reminder-emitted")).toBe(
        true,
      );
      expect(allEvents.some((event) => event.eventType === "support.support-request.review-reminder-emitted")).toBe(
        true,
      );
    });

    it("auto-closes resolved cases past their 7-day clock", async () => {
      let pendingId = "";
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM support_order_sources")) {
            return { rows: [orderSourceRow] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("WHERE order_id")) {
            return { rows: [] };
          }
          if (
            sql.includes("FROM support_request_pages") &&
            sql.includes("WHERE support_request_id = $1") &&
            !sql.includes("buyer_account_id = $2")
          ) {
            return { rows: [{ support_request_id: pendingId }] };
          }
          if (sql.includes("auto_close_due_at <=")) {
            return pendingId ? { rows: [{ support_request_id: pendingId }] } : { rows: [] };
          }
          if (sql.includes("FROM support_request_pages")) {
            return { rows: [] };
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received", openedByRole: "buyer" },
        context,
      );
      pendingId = opened.supportRequestId;
      await runtime.resolveSupportRequest(
        {
          supportRequestId: pendingId,
          accountId: "acc_support",
          resolutionType: "full-refund",
          summary: "Support review completed.",
          scope: "operations",
        },
        context,
      );

      const farFuture = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
      const result = await runtime.sweepSupportRequestDeadlines({ now: farFuture }, context);

      expect(result.autoClosed).toBe(1);
      const closedEvent = allEvents.find((event) => event.eventType === "support.support-request.closed");
      expect(closedEvent?.payload).toMatchObject({ supportRequestId: pendingId });
    });
  });
});
