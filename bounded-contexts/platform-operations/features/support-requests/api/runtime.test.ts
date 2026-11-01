import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { PgQueryable, PgQueryFunction } from "@chase-sets/event-core-postgres";
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
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { actorContext, operationsResponseFixture, responseCases } from "./participant-attempt.test-support";
import {
  attachmentManifestReferences,
  attachmentOperationStreamId,
  createAttachmentManifest,
} from "../domain/attachment-operation";
import { getSupportResponsibilityReasonDefinitions } from "../domain/responsibility";

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

type RuntimeFixtureQuery = (...args: Parameters<PgQueryFunction>) => Promise<Readonly<{ rows: readonly unknown[] }>>;

function runtimeFixtureDb(query: RuntimeFixtureQuery): PgQueryable {
  return { query: query as PgQueryFunction };
}

// Method syntax so fixtures may declare the optional `values` parameter as required, as `pg` callers pass it.
type RuntimeFixtureDb = Readonly<{
  query(...args: Parameters<PgQueryFunction>): Promise<Readonly<{ rows: readonly unknown[] }>>;
}>;

function completeRuntimeDb(db: RuntimeFixtureDb): PgQueryable {
  return runtimeFixtureDb(async (...args) => {
    const result = await db.query(...args);
    return {
      ...result,
      rows: result.rows.map((row) => {
        if (!row || typeof row !== "object") return row;
        const value = row as Record<string, unknown>;
        return {
          ...value,
          flow_type: value.flow_type ?? "product-not-received",
          status: value.status ?? "open",
        };
      }),
    };
  });
}

const OPERATOR_POLICY_NOW = "2026-06-01T01:00:00.000Z";

function operatorPolicyRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    support_request_id: "sup_1",
    flow_type: "product-not-received",
    status: "open",
    seller_response_due_at: null,
    support_review_due_at: null,
    seller_condition_attestation_due_at: null,
    affected_line_items: [],
    pending_offer: null,
    offers: [],
    resolution: null,
    remedy_approval: null,
    ...overrides,
  };
}

async function readOperatorPolicy(row: Readonly<Record<string, unknown>>) {
  const { eventStore } = createInMemoryEventStore();
  const runtime = createSupportRequestRuntime({
    eventStore,
    checkpointStore: createCheckpointStore(),
    db: runtimeFixtureDb(vi.fn(async () => ({ rows: [row] }))),
  });
  const result = await runtime.getSupportOperationsRequest("sup_1", OPERATOR_POLICY_NOW);
  return result?.operatorPolicy;
}

describe("support operations runtime policy contract", () => {
  const selectableReasons = (flowType: Parameters<typeof getSupportResponsibilityReasonDefinitions>[0]) =>
    getSupportResponsibilityReasonDefinitions(flowType).filter((reason) => reason.operatorSelectable);

  it.each([
    ["all deadlines null", operatorPolicyRow(), null, "response", "product-not-received"],
    [
      "seller response only",
      operatorPolicyRow({ seller_response_due_at: "2026-06-01T03:00:00.000Z" }),
      "2026-06-01T03:00:00.000Z",
      "response",
      "product-not-received",
    ],
    [
      "support review only",
      operatorPolicyRow({ support_review_due_at: "2026-06-01T03:00:00.000Z" }),
      "2026-06-01T03:00:00.000Z",
      "response",
      "product-not-received",
    ],
    [
      "seller attestation only",
      operatorPolicyRow({ seller_condition_attestation_due_at: "2026-06-01T03:00:00.000Z" }),
      "2026-06-01T03:00:00.000Z",
      "response",
      "product-not-received",
    ],
    [
      "all deadlines earliest in each column",
      operatorPolicyRow({
        seller_response_due_at: "2026-06-01T04:00:00.000Z",
        support_review_due_at: "2026-06-01T02:00:00.000Z",
        seller_condition_attestation_due_at: "2026-06-01T03:00:00.000Z",
      }),
      "2026-06-01T02:00:00.000Z",
      "response",
      "product-not-received",
    ],
    [
      "equal earliest deadlines",
      operatorPolicyRow({
        seller_response_due_at: "2026-06-01T02:00:00.000Z",
        support_review_due_at: "2026-06-01T02:00:00.000Z",
        seller_condition_attestation_due_at: "2026-06-01T03:00:00.000Z",
      }),
      "2026-06-01T02:00:00.000Z",
      "response",
      "product-not-received",
    ],
    [
      "deadline exactly now escalates",
      operatorPolicyRow({ seller_response_due_at: OPERATOR_POLICY_NOW }),
      OPERATOR_POLICY_NOW,
      "escalate",
      "product-not-received",
    ],
    [
      "deadline one millisecond future responds",
      operatorPolicyRow({ seller_response_due_at: "2026-06-01T01:00:00.001Z" }),
      "2026-06-01T01:00:00.001Z",
      "response",
      "product-not-received",
    ],
    [
      "deadline before now escalates",
      operatorPolicyRow({ seller_response_due_at: "2026-06-01T00:59:59.999Z" }),
      "2026-06-01T00:59:59.999Z",
      "escalate",
      "product-not-received",
    ],
    [
      "ready for support resolves",
      operatorPolicyRow({ status: "ready-for-support", seller_response_due_at: "2026-05-31T00:00:00.000Z" }),
      "2026-05-31T00:00:00.000Z",
      "resolve",
      "product-not-received",
    ],
    [
      "offset timestamps compare by instant",
      operatorPolicyRow({
        seller_response_due_at: "2026-06-01 06:00:00+05:30",
        support_review_due_at: "2026-06-01 01:00:00+00",
      }),
      "2026-06-01 06:00:00+05:30",
      "escalate",
      "product-damaged",
    ],
  ] as const)("returns complete policy for %s", async (_label, row, deadlineAt, recommendedAction, flowType) => {
    const policy = await readOperatorPolicy({ ...row, flow_type: flowType });
    expect(policy).toEqual({
      deadlineAt,
      recommendedAction,
      responsibilityReasons: selectableReasons(flowType),
      refundCap: null,
      refundPrefill: null,
    });
  });

  it.each([
    ["no lines", {}, null, null],
    ["line sum", { affected_line_items: [{ amount: "12.34", currencyCode: "USD" }] }, "12.34", "12.34"],
    [
      "pending offer takes precedence",
      { affected_line_items: [{ amount: "40.00", currencyCode: "USD" }], pending_offer: { refundAmount: "9.00" } },
      "40.00",
      "9.00",
    ],
    [
      "newest in-cap history offer",
      {
        affected_line_items: [{ amount: "40.00", currencyCode: "USD" }],
        offers: [
          { offeredAt: "2026-05-31T00:00:00.000Z", refundAmount: "8.00" },
          { offeredAt: "2026-06-01T00:00:00.000Z", refundAmount: "10.00" },
        ],
      },
      "40.00",
      "10.00",
    ],
    [
      "over-cap offer clamps",
      { affected_line_items: [{ amount: "12.00", currencyCode: "USD" }], pending_offer: { refundAmount: "15.00" } },
      "12.00",
      "12.00",
    ],
    [
      "malformed amount has no cap",
      { affected_line_items: [{ amount: "not-money", currencyCode: "USD" }], pending_offer: { refundAmount: "5.00" } },
      null,
      "5.00",
    ],
    ["offer without a cap", { pending_offer: { refundAmount: "5.00" } }, null, "5.00"],
  ] as const)("returns complete refund policy for %s", async (_label, overrides, refundCap, refundPrefill) => {
    const policy = await readOperatorPolicy(operatorPolicyRow(overrides));
    expect(policy?.refundCap).toBe(refundCap);
    expect(policy?.refundPrefill).toBe(refundPrefill);
  });
});

describe("operations response preservation", () => {
  for (const scenario of responseCases) {
    it(`operations empty resolution remains refused: ${scenario.responseType}`, async () => {
      const f = await operationsResponseFixture(scenario.responseType, "Offer");
      f.db.query.mockResolvedValue({
        rows: [{ support_request_id: f.id, flow_type: scenario.flowType, status: "open", resolution: null }],
      } as never);
      const before = f.allEvents.length;
      await expect(
        f.runtime.recordResponse(
          {
            ...f.body,
            supportRequestId: f.id,
            accountId: f.operator.accountId,
            submittedByRole: "support",
            scope: "operations",
            offerResolutionType: "",
          },
          actorContext(f.operator),
        ),
      ).rejects.toThrow("Support resolution type is not supported.");
      expect(f.allEvents).toHaveLength(before);
    });
    for (const field of [{}, { offerResolutionType: null }]) {
      it(`operations offer omission remains refused: ${scenario.responseType} ${JSON.stringify(field)}`, async () => {
        const f = await operationsResponseFixture(scenario.responseType, "Offer");
        f.db.query.mockResolvedValue({
          rows: [{ support_request_id: f.id, flow_type: scenario.flowType, status: "open", resolution: null }],
        } as never);
        const before = f.allEvents.length;
        const action = f.runtime.recordResponse(
          {
            ...f.body,
            ...field,
            supportRequestId: f.id,
            accountId: f.operator.accountId,
            submittedByRole: "support",
            scope: "operations",
          },
          actorContext(f.operator),
        );
        if (scenario.resolutionType) {
          await expect(action).rejects.toThrow("Support resolution type is not supported.");
          expect(f.allEvents).toHaveLength(before);
        } else {
          await action;
          expect(f.allEvents.find((event) => event.eventType.endsWith(".response-recorded"))?.payload.offer).toBeNull();
        }
      });
    }
    if (scenario.resolutionType) {
      it(`operations explicit offer remains supported: ${scenario.responseType}`, async () => {
        const f = await operationsResponseFixture(scenario.responseType, "Offer");
        f.db.query.mockResolvedValue({
          rows: [{ support_request_id: f.id, flow_type: scenario.flowType, status: "open", resolution: null }],
        } as never);
        await f.runtime.recordResponse(
          {
            ...f.body,
            supportRequestId: f.id,
            accountId: f.operator.accountId,
            submittedByRole: "support",
            scope: "operations",
            offerResolutionType: scenario.resolutionType,
          },
          actorContext(f.operator),
        );
        expect(
          f.allEvents.find((event) => event.eventType.endsWith(".response-recorded"))?.payload.offer,
        ).toMatchObject({ resolutionType: scenario.resolutionType, offeredByRole: "support" });
      });
    }
  }
});

describe("support request runtime", () => {
  it("opens, evidences, and resolves an Honor Offline case idempotently", async () => {
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
                delivered_at: null,
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
      db: completeRuntimeDb(db),
    });
    const input = {
      orderId: "ord_1",
      sellerAccountId: "acc_seller",
      reservationRequestId: "rsv_collision_1",
      holdId: "hld_collision_1",
      releasedAt: "2026-07-17T12:00:00.000Z",
    };

    const first = await runtime.openAutomatedSellerCannotFulfillRequest(input, context);
    const repeated = await runtime.openAutomatedSellerCannotFulfillRequest(input, context);

    expect(repeated).toEqual(first);
    expect(allEvents.filter((event) => event.eventType === "support.support-request.opened")).toHaveLength(1);
    expect(allEvents.filter((event) => event.eventType === "support.support-request.evidence-submitted")).toHaveLength(
      1,
    );
    expect(allEvents.filter((event) => event.eventType === "support.support-request.resolved")).toHaveLength(1);
    expect(allEvents.find((event) => event.eventType === "support.support-request.opened")?.payload).toMatchObject({
      orderId: "ord_1",
      sellerAccountId: "acc_seller",
      flowType: "seller-cannot-fulfill",
      openedByRole: "seller",
    });
    expect(
      allEvents.find((event) => event.eventType === "support.support-request.evidence-submitted")?.payload,
    ).toMatchObject({
      evidence: expect.objectContaining({
        submittedByAccountId: "acc_seller",
        evidenceType: "seller-attestation",
        summary: expect.stringContaining("rsv_collision_1"),
      }),
    });
    expect(allEvents.find((event) => event.eventType === "support.support-request.resolved")?.payload).toMatchObject({
      flowType: "seller-cannot-fulfill",
      resolution: expect.objectContaining({
        resolutionType: "cancel-order",
        responsibility: "seller",
        responsibilityReasonCode: "seller-cannot-fulfill.seller-unable-to-fulfill",
      }),
    });
  });

  it("platform-admin without a grant cannot read another account case even when a read model grants it", async () => {
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
    await eventStore.appendToStream({
      streamId: "support.support-request-sup_case",
      expectedVersion: "any",
      context,
      events: [
        {
          eventType: "support.support-request.opened",
          payload: {
            supportRequestId: "sup_case",
            buyerAccountId: "acc_buyer",
            sellerAccountId: "acc_seller",
            orderReturnContext: [],
          },
        },
        {
          eventType: "support.support-request.evidence-submitted",
          payload: { evidence: { attachments: [reference] } },
        },
      ],
    });
    const storage = {
      putPrivate: vi.fn(),
      readPrivate: vi.fn(async () => ({
        status: "found" as const,
        body,
        byteSize: body.length,
        providerContentType: "image/jpeg",
      })),
      verifyPrivate: vi.fn(),
    };
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: completeRuntimeDb(db),
      attachmentStorage: storage,
    });

    await expect(
      runtime.getAttachment({
        supportRequestId: "sup_case",
        attachmentId: "sea_photo",
        actor: evidenceActor("owner", ["support.view"]),
      }),
    ).resolves.toEqual({ body, contentType: "image/jpeg" });
    await expect(
      runtime.getAttachment({
        supportRequestId: "sup_case",
        attachmentId: "sea_photo",
        actor: evidenceActor("owner", ["support.view"], false, "acc_unrelated"),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runtime.getAttachment({
        supportRequestId: "sup_case",
        attachmentId: "sea_photo",
        actor: evidenceActor("platform-admin", ["support.view"], false, "acc_operator"),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.readPrivate).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("stamps the shipment projection's delivered-at fact onto the open decision", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM support_order_sources")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
                status: "delivered",
                total_amount: "24.00",
                return_context: [],
                delivered_at: "2026-04-08T12:00:00.000Z",
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
    const { eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: completeRuntimeDb(db),
      now: () => "2026-05-09T12:00:00.000Z",
    });

    await expect(
      runtime.openSupportRequest(
        {
          orderId: "ord_1",
          accountId: "acc_buyer",
          flowType: "product-damaged",
        },
        context,
      ),
    ).rejects.toThrow("Order problems must be reported within 30 days of delivery.");

    expect(db.query.mock.calls[0]?.[0]).toContain("support_shipment_sources");
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
      db: completeRuntimeDb(db),
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

    await expect(runtime.resolveSupportFlowDefinition("product-not-received")).resolves.toMatchObject({
      sellerResponseHours: 96,
      supportReviewHours: 48,
    });
    expect(resolvePolicy).toHaveBeenCalledTimes(2);
  });

  it("listFlowDefinitions falls back to the compiled catalog when no policies dependency is wired", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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

  it("records participant evidence and responses with the account-derived role", async () => {
    let supportRequestId = "";
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
        if (sql.includes("WHERE order_id")) return { rows: [] };
        if (sql.includes("FROM support_request_pages") && sql.includes("support_request_id = $1")) {
          return supportRequestId
            ? {
                rows: [
                  {
                    support_request_id: supportRequestId,
                    buyer_account_id: "acc_buyer",
                    seller_account_id: "acc_seller",
                  },
                ],
              }
            : { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: completeRuntimeDb(db),
    });
    const opened = await runtime.openSupportRequest(
      { orderId: "ord_1", accountId: "acc_buyer", flowType: "product-damaged" },
      context,
    );
    supportRequestId = opened.supportRequestId;

    await runtime.submitEvidence(
      {
        supportRequestId,
        accountId: "acc_buyer",
        submittedByRole: "seller",
        evidenceType: "photo",
        summary: "Damaged corner",
      },
      context,
    );
    await runtime.recordResponse(
      {
        supportRequestId,
        accountId: "acc_seller",
        submittedByRole: "support",
        responseType: "issue-refund",
        summary: "Seller agrees to refund.",
      },
      context,
    );

    expect(
      allEvents.find((event) => event.eventType === "support.support-request.evidence-submitted")?.payload,
    ).toMatchObject({
      evidence: { submittedByRole: "buyer" },
    });
    expect(
      allEvents.find((event) => event.eventType === "support.support-request.response-recorded")?.payload,
    ).toMatchObject({
      response: { submittedByRole: "seller" },
    });
  });

  it("only lets the participant who opened a support request cancel it", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            support_request_id: "sup_1",
            buyer_account_id: "acc_buyer",
            seller_account_id: "acc_seller",
            opened_by_account_id: "acc_buyer",
          },
        ],
      })),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createSupportRequestRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: completeRuntimeDb(db),
    });

    await expect(
      runtime.cancelSupportRequest(
        { supportRequestId: "sup_1", accountId: "acc_seller", reason: "Seller cannot cancel buyer case." },
        context,
      ),
    ).rejects.toThrow("Only the account that opened this support request can cancel it.");
    expect(allEvents).toHaveLength(0);
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
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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
      db: completeRuntimeDb(db),
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
        db: completeRuntimeDb(db),
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
        db: completeRuntimeDb(db),
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
        db: completeRuntimeDb(db),
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
        db: completeRuntimeDb(db),
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
            return pendingId
              ? {
                  rows: [
                    {
                      support_request_id: pendingId,
                      buyer_account_id: "acc_buyer",
                      seller_account_id: "acc_seller",
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
        db: completeRuntimeDb(db),
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
        db: completeRuntimeDb(db),
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
        db: completeRuntimeDb(db),
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
      eventStore: EventStore,
    ) {
      const opened = await runtime.openSupportRequest(
        { orderId: "ord_1", accountId: "acc_buyer", flowType: "return-request" },
        context,
      );
      const supportRequestId = opened.supportRequestId;
      setPendingId(supportRequestId);
      const operationId = "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const manifest = createAttachmentManifest({
        owner: { tenantId: context.tenantId, accountId: context.audit.forAccountId, supportRequestId, operationId },
        profile: "support-evidence-raster/v1",
        encoderFingerprint: {
          profile: "support-evidence-raster/v1",
          sharp: "test",
          libvips: "test",
          platform: "test",
          arch: "test",
          libc: "test",
        },
        images: [{ canonicalSha256: "a".repeat(64), contentType: "image/jpeg", byteSize: 10 }],
      });
      await eventStore.appendToStream({
        streamId: attachmentOperationStreamId(manifest.owner),
        expectedVersion: "no_stream",
        context,
        events: [
          { eventType: "support.attachment-operation.staged", payload: manifest },
          { eventType: "support.attachment-operation.stored", payload: { index: 0 } },
        ],
      });

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
          actor: { ...evidenceActor("owner", ["support.manage"], true), tenantId: "tnt_test", userId: "usr_test" },
          attachments: attachmentManifestReferences(manifest),
          attachmentOperationId: operationId,
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
        db: completeRuntimeDb(db),
      });

      await openAndResolveReturnRequest(
        runtime,
        (id) => {
          pendingId = id;
        },
        eventStore,
      );

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
        db: completeRuntimeDb(db),
      });

      await openAndResolveReturnRequest(
        runtime,
        (id) => {
          pendingId = id;
        },
        eventStore,
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
