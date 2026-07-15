import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
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

const operatorSellerNonShipmentFinding = {
  responsibility: "seller",
  evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
  responsibilityReasonCode: "product-not-received.seller-did-not-ship",
} as const;

describe("support request runtime", () => {
  it("limits attachment reads to the buyer, seller, and platform support operator", async () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const reference = `support-attachment:v1:sea_photo:${sha256}:jpg`;
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[]) => {
        const participantScoped = sql.includes("buyer_account_id = $2 OR seller_account_id = $2");
        const accountId = values[1];
        if (participantScoped && accountId !== "acc_buyer" && accountId !== "acc_seller") {
          return { rows: [] };
        }
        return {
          rows: [
            {
              support_request_id: "sup_case",
              buyer_account_id: "acc_buyer",
              seller_account_id: "acc_seller",
              evidence: [{ attachments: [reference] }],
            },
          ],
        };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const storage = {
      putObject: vi.fn(),
      getObject: vi.fn(async () => ({ body, contentType: "image/jpeg" })),
      deleteObjects: vi.fn(),
    };
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      attachmentStorage: storage,
    });

    await expect(
      runtime.getAttachment({
        supportRequestId: "sup_case",
        attachmentId: "sea_photo",
        accountId: "acc_buyer",
        roleKey: "owner",
      }),
    ).resolves.toEqual({ body, contentType: "image/jpeg" });
    await expect(
      runtime.getAttachment({
        supportRequestId: "sup_case",
        attachmentId: "sea_photo",
        accountId: "acc_unrelated",
        roleKey: "owner",
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.getAttachment({
        supportRequestId: "sup_case",
        attachmentId: "sea_photo",
        accountId: "acc_operator",
        roleKey: "platform-admin",
      }),
    ).resolves.toEqual({ body, contentType: "image/jpeg" });
    expect(storage.getObject).toHaveBeenCalledTimes(2);
  });

  it("sources listFlowDefinitions' response-window copy from the resolved support-deadline policy", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const { eventStore } = createInMemoryEventStore();
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "platform-operations.support-deadlines",
      value: {
        "product-not-received": { sellerResponseHours: 96, supportReviewHours: 48 },
      },
      source: "policy" as const,
      documentId: "pol_1",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-05-09T12:00:00.000Z",
    }));
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      policies: { resolvePolicy: resolvePolicy as never },
    });

    const flows = await runtime.listFlowDefinitions();

    expect(flows.find((flow) => flow.flowType === "product-not-received")).toMatchObject({
      sellerResponseHours: 96,
      supportReviewHours: 48,
    });
    // Every other flow falls back to its launch default, single-sourced from the same resolved value.
    expect(flows.find((flow) => flow.flowType === "authenticity-concern")).toMatchObject({
      sellerResponseHours: 24,
      supportReviewHours: 12,
    });
  });

  it("listFlowDefinitions falls back to the compiled catalog when no policies dependency is wired", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const flows = await runtime.listFlowDefinitions();

    expect(flows.find((flow) => flow.flowType === "product-not-received")).toMatchObject({
      sellerResponseHours: 48,
      supportReviewHours: 24,
    });
  });

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
                return_context: [
                  {
                    lineId: "line_1",
                    listingId: "lst_1",
                    itemTitle: "Charizard",
                    productSummary: "Near mint",
                    quantity: 1,
                    gradedCard: null,
                  },
                ],
                affected_line_amounts: [{ lineId: "line_1", amount: "24.00", currencyCode: "USD" }],
              },
            ],
          };
        }

        if (sql.includes("FROM support_request_pages")) {
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
      runtime.getSupportOrderContext({
        orderId: "ord_1",
        accountId: "acc_buyer",
      }),
    ).resolves.toEqual({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
      lines: [
        {
          lineId: "line_1",
          itemTitle: "Charizard",
          productSummary: "Near mint",
          quantity: 1,
          amount: "24.00",
          currencyCode: "USD",
        },
      ],
    });

    await expect(
      runtime.getSupportOrderContext({
        orderId: "ord_1",
        accountId: "acc_seller",
      }),
    ).resolves.toMatchObject({ openedByRole: "seller" });
  });

  it("returns the existing open case for order-level duplicate blocking", async () => {
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
                affected_line_amounts: [],
              },
            ],
          };
        }
        if (sql.includes("FROM support_request_pages")) {
          return {
            rows: [
              {
                support_request_id: "sup_existing",
                display_reference: "SUP-EXISTING",
                flow_type: "product-damaged",
                status: "waiting-on-seller",
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

    await expect(runtime.getSupportOrderContext({ orderId: "ord_1", accountId: "acc_buyer" })).resolves.toMatchObject({
      existingOpenRequest: {
        supportRequestId: "sup_existing",
        displayReference: "SUP-EXISTING",
        flowType: "product-damaged",
        status: "waiting-on-seller",
      },
    });
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
      openedByRole: "buyer",
      status: "waiting-on-seller",
    });
  });

  it("stamps deadlines from the support-deadline policy's resolved value at open time when a policies dependency is wired", async () => {
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
    const { allEvents, eventStore } = createInMemoryEventStore();
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "platform-operations.support-deadlines",
      value: {
        "product-not-received": { sellerResponseHours: 72, supportReviewHours: 36 },
      },
      source: "policy" as const,
      documentId: "pol_1",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-05-09T12:00:00.000Z",
    }));
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      policies: { resolvePolicy: resolvePolicy as never },
    });

    await runtime.openSupportRequest(
      { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received" },
      context,
    );

    expect(resolvePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "platform-operations.support-deadlines" }),
    );
    const openedEvent = allEvents.find((event) => event.eventType === "support.support-request.opened");
    const openedPayload = openedEvent?.payload as {
      openedAt: string;
      sellerResponseDueAt: string;
      supportReviewDueAt: string;
    };
    // 72h and 36h from the resolved policy override, not the catalog's 48h/24h.
    expect(openedPayload.sellerResponseDueAt).toBe(
      new Date(Date.parse(openedPayload.openedAt) + 72 * 60 * 60 * 1000).toISOString(),
    );
    expect(openedPayload.supportReviewDueAt).toBe(
      new Date(Date.parse(openedPayload.openedAt) + 36 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("falls back to the flow catalog's compiled defaults when no policies dependency is wired", async () => {
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
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await runtime.openSupportRequest(
      { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received" },
      context,
    );

    const openedEvent = allEvents.find((event) => event.eventType === "support.support-request.opened");
    const openedPayload = openedEvent?.payload as {
      openedAt: string;
      sellerResponseDueAt: string;
      supportReviewDueAt: string;
    };
    // 48h and 24h -- the flow catalog's compiled defaults for product-not-received.
    expect(openedPayload.sellerResponseDueAt).toBe(
      new Date(Date.parse(openedPayload.openedAt) + 48 * 60 * 60 * 1000).toISOString(),
    );
    expect(openedPayload.supportReviewDueAt).toBe(
      new Date(Date.parse(openedPayload.openedAt) + 24 * 60 * 60 * 1000).toISOString(),
    );
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
        },
        {
          ...context,
          audit: {
            performedByUserId: "usr_seller" as never,
            forAccountId: "acc_seller" as never,
          },
        },
      ),
    ).rejects.toThrow("This support flow cannot be opened by that role.");
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

  describe("escalateOverdueSupportRequests cap reporting", () => {
    function queueRow(supportRequestId: string) {
      return {
        support_request_id: supportRequestId,
        status: "ready-for-support",
        seller_response_due_at: null,
        support_review_due_at: null,
      };
    }

    it("reports the sweep as capped when the active queue holds more candidates than the page limit", async () => {
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("SELECT COUNT(*)") && sql.includes("FROM support_request_pages")) {
            return { rows: [{ count: "5" }] };
          }
          if (sql.includes("FROM support_request_pages")) {
            return { rows: [queueRow("sup_1"), queueRow("sup_2")] };
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

      const result = await runtime.escalateOverdueSupportRequests(
        { now: "2026-06-01T00:00:00.000Z", limit: 2 },
        context,
      );

      // Every candidate is `ready-for-support`, a status the sweep always
      // skips (it needs a human decision, not an automatic escalation), so
      // this isolates the cap signal from escalation outcomes.
      expect(result).toEqual({ escalated: 0, skipped: 2, capped: true, total: 5 });
    });

    it("reports the sweep as not capped when the page covers the whole active queue", async () => {
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("SELECT COUNT(*)") && sql.includes("FROM support_request_pages")) {
            return { rows: [{ count: "1" }] };
          }
          if (sql.includes("FROM support_request_pages")) {
            return { rows: [queueRow("sup_1")] };
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

      const result = await runtime.escalateOverdueSupportRequests(
        { now: "2026-06-01T00:00:00.000Z", limit: 100 },
        context,
      );

      expect(result).toEqual({ escalated: 0, skipped: 1, capped: false, total: 1 });
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received" },
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
          responsibility: "undetermined",
          evidenceBasis: {
            type: "deterministic-policy",
            reference: "support-policy.seller-response-deadline.v1",
          },
          responsibilityReasonCode: "product-not-received.seller-response-deadline-expired",
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "missing-products" },
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-as-described" },
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
      let responseDueAtIso = "";
      let reviewOpenedAtIso = "";
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
                      seller_response_due_at: responseDueAtIso,
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
                      opened_at: reviewOpenedAtIso,
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received" },
        context,
      );
      const reviewCase = await runtime.openSupportRequest(
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "authenticity-concern" },
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
      const reviewPayload = reviewOpenedEvent?.payload as { openedAt: string; supportReviewDueAt: string };
      responseOpenedAtIso = responsePayload.openedAt;
      responseDueAtIso = responsePayload.sellerResponseDueAt;
      // product-not-received: sellerResponseHours = 48, so the halfway point is 24h after opening.
      const halfwayAt = new Date(Date.parse(responseOpenedAtIso) + 24 * 60 * 60 * 1000).toISOString();
      reviewOpenedAtIso = reviewPayload.openedAt;
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
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-not-received" },
        context,
      );
      pendingId = opened.supportRequestId;
      await runtime.resolveSupportRequest(
        {
          supportRequestId: pendingId,
          accountId: "acc_support",
          resolutionType: "full-refund",
          summary: "Support review completed.",
          ...operatorSellerNonShipmentFinding,
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

  describe("return-for-refund refund gate", () => {
    const orderSourceRow = {
      order_id: "ord_1",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
      status: "ready-for-fulfillment",
      total_amount: "24.00",
      return_context: [],
    };

    function createDb(getPendingId: () => string) {
      return {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM support_order_sources")) {
            return { rows: [orderSourceRow] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("WHERE order_id")) {
            return { rows: [] };
          }
          if (sql.includes("return_refund_gate_status = 'awaiting-return-inspection'")) {
            const pendingId = getPendingId();
            return pendingId ? { rows: [{ support_request_id: pendingId }] } : { rows: [] };
          }
          if (sql.includes("FROM support_request_pages") && sql.includes("support_request_id = $1")) {
            const pendingId = getPendingId();
            return pendingId
              ? {
                  rows: [
                    { support_request_id: pendingId, buyer_account_id: "acc_buyer", seller_account_id: "acc_seller" },
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
    }

    async function openAndResolveReturnRequest(
      runtime: ReturnType<typeof createSupportRequestRuntime>,
      setPendingId: (id: string) => void,
    ) {
      const opened = await runtime.openSupportRequest(
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "return-request" },
        context,
      );
      const supportRequestId = opened.supportRequestId;
      setPendingId(supportRequestId);

      await runtime.submitEvidence(
        {
          supportRequestId,
          accountId: "acc_buyer",
          submittedByRole: "buyer",
          evidenceType: "return-reason",
          summary: "Changed my mind within the return window.",
          scope: "operations",
        },
        context,
      );
      await runtime.submitEvidence(
        {
          supportRequestId,
          accountId: "acc_buyer",
          submittedByRole: "buyer",
          evidenceType: "photo",
          summary: "As-received front and back photos.",
          attachments: ["att_1"],
          scope: "operations",
        },
        context,
      );
      await runtime.submitEvidence(
        {
          supportRequestId,
          accountId: "acc_buyer",
          submittedByRole: "buyer",
          evidenceType: "condition-notes",
          summary: "Card appears unchanged from delivery.",
          scope: "operations",
        },
        context,
      );
      await runtime.resolveSupportRequest(
        {
          supportRequestId,
          accountId: "acc_support",
          resolutionType: "return-for-refund",
          summary: "Return accepted.",
          responsibility: "buyer",
          evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
          responsibilityReasonCode: "return-request.buyer-remorse",
          scope: "operations",
        },
        context,
      );

      return supportRequestId;
    }

    it("gates a return-request refund on return delivery and auto-releases it after the 5-day inspection window elapses", async () => {
      let pendingId = "";
      const db = createDb(() => pendingId);
      const { allEvents, eventStore } = createInMemoryEventStore();
      const runtime = createSupportRequestRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      });

      await openAndResolveReturnRequest(runtime, (id) => {
        pendingId = id;
      });

      const resolvedEvent = allEvents.find((event) => event.eventType === "support.support-request.resolved");
      expect(resolvedEvent?.payload).toMatchObject({ resolution: { resolutionType: "return-for-refund" } });
      expect(allEvents.some((event) => event.eventType === "support.support-request.return-refund-released")).toBe(
        false,
      );

      await runtime.recordReturnDelivery(
        {
          supportRequestId: pendingId,
          accountId: "acc_seller",
          deliveredAt: "2026-06-01T00:00:00.000Z",
          scope: "operations",
        },
        context,
      );
      const deliveredEvent = allEvents.find((event) => event.eventType === "support.support-request.return-delivered");
      expect(deliveredEvent?.payload).toMatchObject({
        deliveredAt: "2026-06-01T00:00:00.000Z",
        returnRefundReleaseDueAt: "2026-06-06T00:00:00.000Z",
      });

      const tooEarly = await runtime.sweepSupportRequestDeadlines({ now: "2026-06-05T23:00:00.000Z" }, context);
      expect(tooEarly.returnRefundsReleased).toBe(0);

      const result = await runtime.sweepSupportRequestDeadlines({ now: "2026-06-06T00:00:00.000Z" }, context);
      expect(result.returnRefundsReleased).toBe(1);
      const releasedEvent = allEvents.find(
        (event) => event.eventType === "support.support-request.return-refund-released",
      );
      expect(releasedEvent?.payload).toMatchObject({ releasedByRole: null, releasedByAccountId: null });
    });

    it("rejects a return-condition dispute from the buyer, accepts it from the seller, and lets support manually release it", async () => {
      let pendingId = "";
      const db = createDb(() => pendingId);
      const { allEvents, eventStore } = createInMemoryEventStore();
      const runtime = createSupportRequestRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      });

      await openAndResolveReturnRequest(runtime, (id) => {
        pendingId = id;
      });
      await runtime.recordReturnDelivery(
        {
          supportRequestId: pendingId,
          accountId: "acc_seller",
          deliveredAt: "2026-06-01T00:00:00.000Z",
          scope: "operations",
        },
        context,
      );

      await expect(
        runtime.disputeReturnCondition(
          { supportRequestId: pendingId, accountId: "acc_buyer", reason: "The buyer should not be able to do this." },
          context,
        ),
      ).rejects.toThrow("Only the seller can dispute the returned item's condition.");

      await runtime.disputeReturnCondition(
        { supportRequestId: pendingId, accountId: "acc_seller", reason: "Card came back with new damage." },
        context,
      );
      const disputedEvent = allEvents.find(
        (event) => event.eventType === "support.support-request.return-condition-disputed",
      );
      expect(disputedEvent?.payload).toMatchObject({ reason: "Card came back with new damage." });

      const sweepResult = await runtime.sweepSupportRequestDeadlines({ now: "2026-06-10T00:00:00.000Z" }, context);
      expect(sweepResult.returnRefundsReleased).toBe(0);

      await runtime.releaseReturnRefund({ supportRequestId: pendingId, accountId: "acc_support" }, context);
      const releasedEvent = allEvents.find(
        (event) => event.eventType === "support.support-request.return-refund-released",
      );
      expect(releasedEvent?.payload).toMatchObject({ releasedByRole: "support", releasedByAccountId: "acc_support" });
    });
  });
});
