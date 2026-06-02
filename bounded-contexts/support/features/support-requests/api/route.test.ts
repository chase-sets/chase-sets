import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SupportApiEnv } from "../../../api";
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
    checklist: [],
    evidence: [],
    responses: [],
    resolution: null,
    closed_at: null,
    cancellation_reason: null,
  };
}

function createServices(overrides: Partial<SupportRequestServices> = {}): SupportRequestServices {
  return {
    commandHandler: vi.fn(),
    listFlowDefinitions: vi.fn(() => []),
    openSupportRequest: vi.fn(),
    submitEvidence: vi.fn(),
    recordResponse: vi.fn(),
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
