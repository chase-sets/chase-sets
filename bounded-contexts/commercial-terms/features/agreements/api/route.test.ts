import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CommercialTermsApiEnv } from "../../../api";
import { createAgreementRoutes } from "./route";
import type { AgreementServices } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createApp(services: Partial<AgreementServices>, permissions: readonly string[]) {
  const app = new Hono<CommercialTermsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey: "admin",
      permissions,
    });
    c.set("context", context);
    await next();
  });
  app.route("/", createAgreementRoutes(services as AgreementServices));
  return app;
}

describe("commercial terms agreement routes", () => {
  it("requires manage permission for agreement revisions", async () => {
    const reviseAgreement = vi.fn();
    const app = createApp({ reviseAgreement }, ["commercial-terms.view"]);

    const response = await app.request("/cag_1", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(reviseAgreement).not.toHaveBeenCalled();
  });

  it("revises account agreement terms through the admin API", async () => {
    const reviseAgreement = vi.fn(async () => ({ agreementId: "cag_1", version: 2 }));
    const app = createApp({ reviseAgreement }, ["commercial-terms.manage"]);

    const response = await app.request("/cag_1", {
      method: "PUT",
      body: JSON.stringify({
        label: "Preferred renewal",
        marketplaceSalesFeePercentageBps: 600,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: "2027-05-01T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "cag_1", version: 2 });
    expect(reviseAgreement).toHaveBeenCalledWith(
      "cag_1",
      expect.objectContaining({
        label: "Preferred renewal",
        marketplaceSalesFeePercentageBps: 600,
        shippingAllowancePercentageBps: 800,
      }),
      context,
    );
  });
});
