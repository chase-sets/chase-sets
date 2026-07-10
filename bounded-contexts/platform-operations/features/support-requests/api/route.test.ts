import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SupportApiEnv } from "./http";
import { createAccountSupportRequestRoutes } from "./route";
import type { SupportRequestServices } from "./runtime";

function buildApp(services: SupportRequestServices, permissions: readonly string[] = ["support.manage"]) {
  const app = new Hono<SupportApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_operator",
      tenantId: "tnt_chase_sets",
      userId: "usr_operator",
      accountId: "acc_operator",
      membershipId: "mem_operator",
      roleKey: "platform-admin",
      permissions: [...permissions],
    });
    c.set("context", {
      tenantId: "tnt_chase_sets",
      audit: { performedByUserId: "usr_operator", forAccountId: "acc_operator" },
    } as never);
    await next();
  });

  app.route("/support-requests", createAccountSupportRequestRoutes(services));

  return app;
}

function supportRequestDetail() {
  return {
    support_request_id: "sup_1",
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    flow_type: "product-not-received",
    status: "ready-for-support",
    priority: "urgent",
    opened_by_account_id: "acc_buyer",
    opened_by_role: "buyer",
    opened_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    seller_response_due_at: null,
    support_review_due_at: "2026-06-02T00:00:00.000Z",
    seller_condition_attestation_due_at: null,
    order_return_context: [],
    return_investigation: null,
    checklist: [],
    evidence: [],
    responses: [],
    offers: [],
    pending_offer: null,
    resolution: null,
    closed_at: null,
    cancellation_reason: null,
    escalated_at: null,
    escalated_by_account_id: null,
    escalated_by_role: null,
    escalation_reason: null,
  };
}

function createServices(overrides: Partial<SupportRequestServices> = {}): SupportRequestServices {
  return {
    commandHandler: vi.fn(),
    listFlowDefinitions: vi.fn(() => []),
    getSupportOrderContext: vi.fn(),
    openSupportRequest: vi.fn(),
    submitEvidence: vi.fn(),
    recordResponse: vi.fn(),
    acceptOffer: vi.fn(),
    declineOffer: vi.fn(),
    escalateSupportRequest: vi.fn(),
    resolveSupportRequest: vi.fn(),
    closeSupportRequest: vi.fn(),
    cancelSupportRequest: vi.fn(),
    escalateOverdueSupportRequests: vi.fn(),
    listSupportOperationsQueue: vi.fn(),
    listBuyerSupportRequests: vi.fn(),
    listSellerSupportRequests: vi.fn(),
    getAccountSupportRequest: vi.fn(),
    getSupportOperationsRequest: vi.fn(async () => supportRequestDetail()),
    projectors: [],
    ...overrides,
  } as unknown as SupportRequestServices;
}

describe("support request routes", () => {
  it("returns account-scoped support order context for marketplace support lookup", async () => {
    const getSupportOrderContext = vi.fn(async () => ({
      orderId: "ord_1",
      openedByRole: "buyer" as const,
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
    }));
    const services = createServices({ getSupportOrderContext });

    const response = await buildApp(services, ["support.view"]).request("/support-requests/orders/ord_1?role=buyer");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
    });
    expect(getSupportOrderContext).toHaveBeenCalledWith({
      orderId: "ord_1",
      accountId: "acc_operator",
      openedByRole: "buyer",
    });
  });

  it.each([
    [
      "openSupportRequest",
      "/support-requests",
      { orderId: "ord_1", flowType: "product-not-received", openedByRole: "buyer" },
      { id: "sup_open", version: 1, status: "opened" },
    ],
    [
      "submitEvidence",
      "/support-requests/sup_1/evidence",
      { submittedByRole: "buyer", evidenceType: "photo", summary: "Package photo", attachments: ["att_1"] },
      { id: "sup_1", version: 2, status: "evidence-submitted" },
    ],
    [
      "recordResponse",
      "/support-requests/sup_1/responses",
      {
        submittedByRole: "seller",
        responseType: "challenge-with-evidence",
        summary: "Carrier scan attached",
        offerResolutionType: null,
        refundAmount: null,
      },
      { id: "sup_1", version: 3, status: "response-recorded" },
    ],
    [
      "acceptOffer",
      "/support-requests/sup_1/offers/sof_1/accept",
      {},
      { id: "sup_1", version: 8, status: "offer-accepted" },
    ],
    [
      "declineOffer",
      "/support-requests/sup_1/offers/sof_1/decline",
      { summary: "I still need support to review this." },
      { id: "sup_1", version: 9, status: "offer-declined" },
    ],
    [
      "escalateSupportRequest",
      "/support-requests/sup_1/escalate",
      { reason: "Needs support review" },
      { id: "sup_1", version: 4, status: "escalated" },
    ],
    [
      "resolveSupportRequest",
      "/support-requests/sup_1/resolve",
      { resolutionType: "replacement", summary: "Replacement approved" },
      { id: "sup_1", version: 5, status: "resolved" },
    ],
    ["closeSupportRequest", "/support-requests/sup_1/close", {}, { id: "sup_1", version: 6, status: "closed" }],
    [
      "cancelSupportRequest",
      "/support-requests/sup_1/cancel",
      { reason: "Buyer withdrew request" },
      { id: "sup_1", version: 7, status: "cancelled" },
    ],
  ] as const)("returns a command-owned snapshot for %s", async (methodName, path, body, expected) => {
    const command = vi.fn(async () => ({
      supportRequestId: expected.id,
      version: expected.version,
    }));
    const services = createServices({ [methodName]: command } as Partial<SupportRequestServices>);

    const response = await buildApp(services).request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(methodName === "openSupportRequest" ? 201 : 200);
    await expect(response.json()).resolves.toEqual(expected);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("returns command-owned support operations escalation counts", async () => {
    const escalateOverdueSupportRequests = vi.fn(async () => ({ escalated: 3, skipped: 2 }));
    const services = createServices({ escalateOverdueSupportRequests });

    const response = await buildApp(services).request("/support-requests/ops/escalate-overdue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 10 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ escalated: 3, skipped: 2 });
    expect(escalateOverdueSupportRequests).toHaveBeenCalledWith({ limit: 10 }, expect.any(Object));
  });

  it.each([
    [
      "submitEvidence",
      "/support-requests/ops/sup_1/evidence",
      { evidenceType: "support-note", summary: "Operator note" },
      {
        id: "sup_1",
        version: 8,
        status: "evidence-submitted",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          submittedByRole: "support",
          evidenceType: "support-note",
          summary: "Operator note",
          occurredAt: null,
          attachments: [],
          scope: "operations",
        },
      },
    ],
    [
      "recordResponse",
      "/support-requests/ops/sup_1/responses",
      { responseType: "request-support-review", summary: "Reviewed by support" },
      {
        id: "sup_1",
        version: 9,
        status: "response-recorded",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          submittedByRole: "support",
          responseType: "request-support-review",
          summary: "Reviewed by support",
          offerResolutionType: null,
          refundAmount: null,
          scope: "operations",
        },
      },
    ],
    [
      "escalateSupportRequest",
      "/support-requests/ops/sup_1/escalate",
      { reason: "Needs support owner" },
      {
        id: "sup_1",
        version: 10,
        status: "escalated",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          reason: "Needs support owner",
          scope: "operations",
        },
      },
    ],
    [
      "resolveSupportRequest",
      "/support-requests/ops/sup_1/resolve",
      { resolutionType: "support-reviewed", summary: "Reviewed", refundAmount: null },
      {
        id: "sup_1",
        version: 11,
        status: "resolved",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          resolutionType: "support-reviewed",
          summary: "Reviewed",
          refundAmount: null,
          scope: "operations",
        },
      },
    ],
    [
      "closeSupportRequest",
      "/support-requests/ops/sup_1/close",
      {},
      {
        id: "sup_1",
        version: 12,
        status: "closed",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          scope: "operations",
        },
      },
    ],
    [
      "cancelSupportRequest",
      "/support-requests/ops/sup_1/cancel",
      { reason: "Duplicate case" },
      {
        id: "sup_1",
        version: 13,
        status: "cancelled",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          reason: "Duplicate case",
          scope: "operations",
        },
      },
    ],
  ] as const)("returns an ops-scoped command snapshot for %s", async (methodName, path, body, expectation) => {
    const command = vi.fn(async () => ({
      supportRequestId: expectation.id,
      version: expectation.version,
    }));
    const services = createServices({ [methodName]: command } as Partial<SupportRequestServices>);

    const response = await buildApp(services).request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: expectation.id,
      version: expectation.version,
      status: expectation.status,
    });
    expect(command).toHaveBeenCalledWith(expectation.expected, expect.any(Object));
  });

  it("lets support operators read request details outside participant account scope", async () => {
    const services = createServices();
    const response = await buildApp(services).request("/support-requests/ops/sup_1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      support_request_id: "sup_1",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
    });
    expect(services.getSupportOperationsRequest).toHaveBeenCalledWith("sup_1");
  });

  it("keeps operations detail reads behind support manage permission", async () => {
    const response = await buildApp(createServices(), ["support.view"]).request("/support-requests/ops/sup_1");

    expect(response.status).toBe(403);
  });
});
