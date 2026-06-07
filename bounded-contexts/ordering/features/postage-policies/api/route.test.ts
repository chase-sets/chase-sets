import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OrderingApiEnv } from "../../../api";
import { createPostagePolicyRoutes } from "./route";
import type { PostagePolicyServices } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createApp(services: Partial<PostagePolicyServices>, permissions: readonly string[]) {
  const app = new Hono<OrderingApiEnv>();
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
  app.route("/", createPostagePolicyRoutes(services as PostagePolicyServices));
  return app;
}

describe("ordering postage policy routes", () => {
  it("requires manage permission for activation", async () => {
    const activatePolicy = vi.fn();
    const app = createApp({ activatePolicy }, ["postage-policies.view"]);

    const response = await app.request("/opp_test/activate", {
      method: "POST",
      body: JSON.stringify({ activationReason: "Reviewed" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(activatePolicy).not.toHaveBeenCalled();
  });

  it("activates policies through the admin API", async () => {
    const activatePolicy = vi.fn(async () => ({ policyId: "opp_test", version: 3 }));
    const app = createApp({ activatePolicy }, ["postage-policies.manage"]);

    const response = await app.request("/opp_test/activate", {
      method: "POST",
      body: JSON.stringify({ activationReason: "Reviewed policy thresholds." }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "opp_test", version: 3 });
    expect(activatePolicy).toHaveBeenCalledWith(
      "opp_test",
      {
        activatedByUserId: "usr_admin",
        activationReason: "Reviewed policy thresholds.",
      },
      context,
    );
  });

  it("previews package-plan outcomes through the admin API", async () => {
    const previewPolicy = vi.fn(() => ({
      packagePlanVersion: "measured-package-plan-v1",
      packageCount: 1,
      packages: [],
      letterEligibility: { eligible: true, reasons: [] },
      postagePolicySnapshot: {
        policyVersion: "operator-postage-v1",
        parcelRequired: false,
        parcelReasons: [],
        signatureRequired: false,
        signatureReasons: [],
      },
      missingProductIds: [],
    }));
    const app = createApp({ previewPolicy }, ["postage-policies.manage"]);

    const response = await app.request("/preview", {
      method: "POST",
      body: JSON.stringify({
        policy: { policyVersion: "operator-postage-v1" },
        shippingOption: "standard",
        itemSubtotalAmount: "25.00",
        quantity: 1,
        physicalFlags: ["raw-card"],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      packagePlan: {
        postagePolicySnapshot: {
          policyVersion: "operator-postage-v1",
        },
      },
    });
    expect(previewPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        shippingOption: "standard",
        physicalFlags: ["raw-card"],
      }),
    );
  });

  it("clones policies as rollback drafts through the admin API", async () => {
    const clonePolicy = vi.fn(async () => ({ policyId: "opp_clone", version: 1 }));
    const app = createApp({ clonePolicy }, ["postage-policies.manage"]);

    const response = await app.request("/opp_old/clone", {
      method: "POST",
      body: JSON.stringify({
        label: "Rollback draft",
        effectiveFrom: "2026-06-07T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "opp_clone", version: 1 });
    expect(clonePolicy).toHaveBeenCalledWith(
      "opp_old",
      {
        label: "Rollback draft",
        effectiveFrom: "2026-06-07T00:00:00.000Z",
        effectiveUntil: null,
        createdByUserId: "usr_admin",
      },
      context,
    );
  });
});
