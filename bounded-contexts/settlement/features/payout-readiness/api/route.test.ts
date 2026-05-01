import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SettlementApiEnv } from "../../../api";
import { createPayoutReadinessRoutes } from "./route";
import type { PayoutReadinessServices } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_seller" as never,
  },
};

function createApp(
  services: Partial<PayoutReadinessServices>,
  permissions: readonly string[] | null,
) {
  const app = new Hono<SettlementApiEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "actor",
      permissions
        ? {
            sessionId: "ses_test",
            tenantId: "tnt_test",
            userId: "usr_test",
            accountId: "acc_seller",
            membershipId: "mem_test",
            roleKey: "seller",
            permissions,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", createPayoutReadinessRoutes(services as PayoutReadinessServices));
  return app;
}

describe("settlement payout setup routes", () => {
  it("requires payout management permission for onboarding sessions", async () => {
    const app = createApp({}, ["payouts.view"]);

    const response = await app.request("/payout-setup/onboarding-session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
  });

  it("creates onboarding sessions for sellers that can manage payouts", async () => {
    const createOnboardingSession = vi.fn(async () => ({
      providerReference: "acct_test",
      url: "https://connect.test/setup",
      expiresAt: null,
    }));
    const app = createApp({ createOnboardingSession }, ["payouts.manage"]);

    const response = await app.request("/payout-setup/onboarding-session", {
      method: "POST",
      body: JSON.stringify({
        returnUrl: "https://example.test/return",
        refreshUrl: "https://example.test/refresh",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      url: "https://connect.test/setup",
    });
    expect(createOnboardingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        returnUrl: "https://example.test/return",
        refreshUrl: "https://example.test/refresh",
      }),
      context,
    );
  });

  it("refreshes payout setup for sellers that can manage payouts", async () => {
    const refreshProviderReadiness = vi.fn(async () => ({
      account_id: "acc_seller",
      status: "ready",
      missing_requirements: [],
    }));
    const app = createApp({ refreshProviderReadiness }, ["payouts.manage"]);

    const response = await app.request("/payout-setup/refresh", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(refreshProviderReadiness).toHaveBeenCalledWith(
      { accountId: "acc_seller" },
      context,
    );
  });
});
