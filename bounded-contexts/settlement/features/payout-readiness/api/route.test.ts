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

function createApp(services: unknown, permissions: readonly string[] | null) {
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
  it("requires authentication for embedded setup sessions", async () => {
    const createPayoutSetupSession = vi.fn();
    const app = createApp({ createPayoutSetupSession }, null);

    const response = await app.request("/payout-setup/embedded-session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(401);
    expect(createPayoutSetupSession).not.toHaveBeenCalled();
  });

  it("requires payout setup permission for embedded setup sessions", async () => {
    const createPayoutSetupSession = vi.fn();
    const app = createApp({ createPayoutSetupSession }, ["payouts.view"]);

    const response = await app.request("/payout-setup/embedded-session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(createPayoutSetupSession).not.toHaveBeenCalled();
  });

  it("creates embedded payout setup sessions for sellers that can manage payouts", async () => {
    const createPayoutSetupSession = vi.fn(async () => ({
      providerReference: "acct_test",
      clientSecret: "provider_session_secret",
      expiresAt: "2026-06-01T15:00:00.000Z",
      components: ["payout-setup"],
    }));
    const app = createApp({ createPayoutSetupSession }, ["payouts.setup"]);

    const response = await app.request("/payout-setup/embedded-session", {
      method: "POST",
      body: JSON.stringify({ contactEmail: "seller@example.test" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      providerReference: "acct_test",
      clientSecret: "provider_session_secret",
      expiresAt: "2026-06-01T15:00:00.000Z",
      components: ["payout-setup"],
    });
    expect(createPayoutSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        contactEmail: "seller@example.test",
      }),
      context,
    );
  });

  it("returns payout setup progress for payout viewers", async () => {
    const getPayoutSetupProgress = vi.fn(async () => ({
      account_id: "acc_seller",
      status: "pending",
      ready: false,
      last_checked_at: null,
      missing_requirement_groups: [
        {
          id: "payout-account",
          label: "Payout account",
          count: 1,
          detail: "Add or confirm the payout account before requesting payouts.",
        },
      ],
      steps: [
        {
          id: "payout-setup",
          label: "Payout setup",
          status: "pending",
          detail: "Continue the payout setup page.",
        },
      ],
    }));
    const app = createApp({ getPayoutSetupProgress }, ["payouts.view"]);

    const response = await app.request("/payout-setup/progress");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account_id: "acc_seller",
      missing_requirement_groups: [expect.objectContaining({ id: "payout-account", label: "Payout account" })],
      steps: [expect.objectContaining({ id: "payout-setup" })],
    });
    expect(getPayoutSetupProgress).toHaveBeenCalledWith("acc_seller");
  });

  it("requires payout setup permission for embedded account management sessions", async () => {
    const createPayoutAccountManagementSession = vi.fn();
    const app = createApp({ createPayoutAccountManagementSession }, ["payouts.view"]);

    const response = await app.request("/payout-setup/account-management-embedded-session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(createPayoutAccountManagementSession).not.toHaveBeenCalled();
  });

  it("creates embedded account management sessions through the payout adapter", async () => {
    const createPayoutAccountManagementSession = vi.fn(async () => ({
      providerReference: "acct_test",
      clientSecret: "provider_management_secret",
      expiresAt: "2026-06-01T15:30:00.000Z",
      components: ["payout-account-management"],
    }));
    const app = createApp({ createPayoutAccountManagementSession }, ["payouts.setup"]);

    const response = await app.request("/payout-setup/account-management-embedded-session", {
      method: "POST",
      body: JSON.stringify({ returnUrl: "https://attacker.test/ignored" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      providerReference: "acct_test",
      clientSecret: "provider_management_secret",
      expiresAt: "2026-06-01T15:30:00.000Z",
      components: ["payout-account-management"],
    });
    expect(createPayoutAccountManagementSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
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
    const app = createApp({ refreshProviderReadiness }, ["payouts.setup"]);

    const response = await app.request("/payout-setup/refresh", {
      method: "POST",
      body: JSON.stringify({ contactEmail: "seller@example.test", providerReference: "acct_test" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(refreshProviderReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        contactEmail: "seller@example.test",
        providerReference: "acct_test",
      }),
      context,
    );
  });

  it("does not expose manual provider readiness mutation to sellers", async () => {
    const recordProviderReadiness = vi.fn();
    const app = createApp({ recordProviderReadiness }, ["payouts.setup"]);

    const response = await app.request("/payout-readiness/provider-status", {
      method: "POST",
      body: JSON.stringify({ status: "ready" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(404);
    expect(recordProviderReadiness).not.toHaveBeenCalled();
  });
});
