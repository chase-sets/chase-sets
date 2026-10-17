import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CommercialTermsApiEnv } from "../../../api";
import { createResolutionRoutes } from "./route";
import type { ResolutionServices } from "./runtime";

const previewTerms: ResolutionServices["previewListingTerms"] = async (input) => ({
  accountId: input.accountId,
  accountType: "business",
  basisAmount: input.amount,
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

function createApp(services: Partial<ResolutionServices>, permissions: readonly string[], roleKey = "platform-admin") {
  const app = new Hono<CommercialTermsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey,
      permissions,
    });
    await next();
  });
  app.route("/", createResolutionRoutes(services as ResolutionServices));
  return app;
}

describe("commercial terms resolution routes", () => {
  it.each(["listing", "order"])("preview ignores a foreign accountId for non-admin actors (%s)", async (scope) => {
    for (const roleKey of ["owner", "manager", "viewer", "admin"]) {
      const previewListingTerms = vi.fn(previewTerms);
      const previewOrderTerms = vi.fn(previewTerms);
      const app = createApp(
        { previewListingTerms, previewOrderTerms },
        ["commercial-terms.view", "commercial-terms.manage"],
        roleKey,
      );

      const response = await app.request("/preview", {
        method: "POST",
        body: JSON.stringify({ scope, accountId: "acc_seller", amount: "100.00" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ accountId: "acc_admin" });
      expect(scope === "order" ? previewOrderTerms : previewListingTerms).toHaveBeenCalledWith({
        accountId: "acc_admin",
        amount: "100.00",
        effectiveAt: undefined,
      });
      expect(scope === "order" ? previewListingTerms : previewOrderTerms).not.toHaveBeenCalled();
    }
  });

  it.each(["listing", "order"])("platform admin previews the requested account (%s)", async (scope) => {
    const previewListingTerms = vi.fn(previewTerms);
    const previewOrderTerms = vi.fn(previewTerms);
    const app = createApp({ previewListingTerms, previewOrderTerms }, ["commercial-terms.view"]);

    const response = await app.request("/preview", {
      method: "POST",
      body: JSON.stringify({ scope, accountId: "acc_seller", amount: "100.00" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accountId: "acc_seller" });
    expect(scope === "order" ? previewOrderTerms : previewListingTerms).toHaveBeenCalledWith({
      accountId: "acc_seller",
      amount: "100.00",
      effectiveAt: undefined,
    });
    expect(scope === "order" ? previewListingTerms : previewOrderTerms).not.toHaveBeenCalled();
  });

  it.each(["owner", "platform-admin"])("preview defaults to the actor account for %s", async (roleKey) => {
    for (const scope of ["listing", "order"]) {
      const previewListingTerms = vi.fn(previewTerms);
      const previewOrderTerms = vi.fn(previewTerms);
      const app = createApp({ previewListingTerms, previewOrderTerms }, ["commercial-terms.view"], roleKey);

      const response = await app.request("/preview", {
        method: "POST",
        body: JSON.stringify({ scope, amount: "100.00" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ accountId: "acc_admin" });
    }
  });

  it("returns the calculated listing terms snapshot for preview", async () => {
    const previewListingTerms = vi.fn(previewTerms);
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
