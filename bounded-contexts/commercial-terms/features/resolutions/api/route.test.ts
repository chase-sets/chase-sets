import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CommercialTermsApiEnv } from "../../../api";
import { createResolutionRoutes } from "./route";
import type { ResolutionServices } from "./runtime";

function createApp(services: Partial<ResolutionServices>, permissions: readonly string[]) {
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
    await next();
  });
  app.route("/", createResolutionRoutes(services as ResolutionServices));
  return app;
}

describe("commercial terms resolution routes", () => {
  it("returns the calculated listing terms snapshot for preview", async () => {
    const previewListingTerms = vi.fn(async () => ({
      accountId: "acc_seller",
      accountType: "business" as const,
      basisAmount: "100.00",
      marketplaceSalesFeeUnitAmount: "5.00",
      sellerNetUnitAmount: "95.00",
      marketplaceSalesFeePercentageBps: 500,
      marketplaceSalesFeeFixedAmount: "0.00",
      marketplaceSalesFeeCapAmount: "25.00",
      shippingAllowancePercentageBps: 750,
      scheduleId: "cts_business",
      agreementId: null,
      resolvedAt: "2026-05-01T00:00:00.000Z",
    }));
    const app = createApp({ previewListingTerms }, ["commercial-terms.view"]);

    const response = await app.request("/preview", {
      method: "POST",
      body: JSON.stringify({
        scope: "listing",
        accountId: "acc_seller",
        amount: "100.00",
        effectiveAt: "2026-05-01T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      accountType: "business",
      basisAmount: "100.00",
      marketplaceSalesFeeUnitAmount: "5.00",
      sellerNetUnitAmount: "95.00",
      marketplaceSalesFeePercentageBps: 500,
      marketplaceSalesFeeFixedAmount: "0.00",
      marketplaceSalesFeeCapAmount: "25.00",
      shippingAllowancePercentageBps: 750,
      scheduleId: "cts_business",
      agreementId: null,
      resolvedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(previewListingTerms).toHaveBeenCalledWith({
      accountId: "acc_seller",
      amount: "100.00",
      effectiveAt: "2026-05-01T00:00:00.000Z",
    });
  });
});
