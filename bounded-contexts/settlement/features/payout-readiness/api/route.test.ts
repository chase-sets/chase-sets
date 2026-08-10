import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettlementApiEnv } from "../../../api";
import { createPayoutReadinessRoutes } from "./route";
import { PayoutAccountManagementError, type PayoutReadinessServices } from "./runtime";

const originalFetch = globalThis.fetch;

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_seller" as never,
  },
};

function createApp(
  services: unknown,
  permissions: readonly string[] | null,
  actorOverrides: Readonly<{ authenticatedAt?: string | null }> = {},
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
            ...actorOverrides,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", createPayoutReadinessRoutes(services as PayoutReadinessServices));
  return app;
}

function mockIdentityCurrentActorDisplay(email: string | null) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("http://localhost/api/identity/current-actor-display");
    return Response.json({
      account: {
        account_id: "acc_seller",
        display_name: "Seller Account",
        name: "Seller Account",
        badges: [],
      },
      membership: {
        membership_id: "mem_test",
        role_key: "seller",
      },
      user: {
        user_id: "usr_test",
        display_name: "Seller User",
        primary_email: email,
      },
    });
  });
  globalThis.fetch = fetch as typeof fetch;
  return fetch;
}

describe("settlement payout setup routes", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

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
      readiness: {
        account_id: "acc_seller",
        status: "pending",
        missing_requirements: ["external_account"],
        provider_reference: "acct_test",
        onboarding_status: "pending",
        transfer_capability_status: "pending",
        payout_capability_status: "pending",
        payout_destination_status: "missing",
        payout_account_dashboard: "none",
        losses_collector: "application",
        fees_collector: "application",
        requirements_collector: "application",
        updated_at: "2026-06-01T15:00:00.000Z",
      },
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
      readiness: expect.objectContaining({
        account_id: "acc_seller",
        status: "pending",
        provider_reference: "acct_test",
      }),
    });
    expect(createPayoutSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        contactEmail: "seller@example.test",
      }),
      context,
    );
  });

  it("derives setup contact email from the authenticated actor when the browser body is empty", async () => {
    const createPayoutSetupSession = vi.fn(async () => ({
      providerReference: "acct_test",
      clientSecret: "provider_session_secret",
      expiresAt: "2026-06-01T15:00:00.000Z",
      components: ["payout-setup"],
    }));
    const fetch = mockIdentityCurrentActorDisplay("seller@example.test");
    const app = createApp({ createPayoutSetupSession }, ["payouts.setup"]);

    const response = await app.request("http://localhost/payout-setup/embedded-session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("forwards the acting session's authentication moment and never a request-body token", async () => {
    const createPayoutAccountManagementSession = vi.fn(async (_params: Record<string, unknown>) => ({
      providerReference: "acct_test",
      clientSecret: "provider_management_secret",
      expiresAt: null,
      components: ["payout-account-management"],
    }));
    const authenticatedAt = "2026-06-01T15:55:00.000Z";
    const app = createApp({ createPayoutAccountManagementSession }, ["payouts.setup"], { authenticatedAt });

    // Predecessor-shaped request: the retired contract's token is the only
    // security input this body carries, and it must reach nothing.
    const response = await app.request("/payout-setup/account-management-embedded-session", {
      method: "POST",
      body: JSON.stringify({ sensitiveActionToken: "fresh-step-up" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    const params = createPayoutAccountManagementSession.mock.calls[0]?.[0];
    // Exact equality: the only inputs that reach the runtime are the account
    // scope and Auth's own authentication moment -- no caller-supplied
    // credential, and no acting-user field the gate does not read.
    expect(params).toEqual({ accountId: "acc_seller", authenticatedAt });
  });

  it("returns machine-coded step_up_required when the runtime refuses on authentication freshness", async () => {
    const createPayoutAccountManagementSession = vi.fn(async () => {
      throw new PayoutAccountManagementError(
        "step_up_required",
        "Confirm it is you before managing payout account details.",
      );
    });
    const app = createApp({ createPayoutAccountManagementSession }, ["payouts.setup"]);

    const response = await app.request("/payout-setup/account-management-embedded-session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "step_up_required" } });
  });

  it("keeps a provider-authority failure distinct from step_up_required", async () => {
    const createPayoutAccountManagementSession = vi.fn(async () => {
      throw new PayoutAccountManagementError(
        "missing_provider_account",
        "Payout setup must be started before managing payout account details.",
      );
    });
    const app = createApp({ createPayoutAccountManagementSession }, ["payouts.setup"]);

    const response = await app.request("/payout-setup/account-management-embedded-session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "Payout setup must be started before managing payout account details.",
      },
    });
  });

  it("allows payout viewers to create the read-only notification banner session", async () => {
    const createPayoutNotificationBannerSession = vi.fn(async () => ({
      providerReference: "acct_test",
      clientSecret: "provider_banner_secret",
      expiresAt: "2026-06-01T15:30:00.000Z",
      components: ["notification-banner"],
    }));
    const app = createApp({ createPayoutNotificationBannerSession }, ["payouts.view"]);

    const response = await app.request("/payout-setup/notification-banner-session", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      providerReference: "acct_test",
      clientSecret: "provider_banner_secret",
      expiresAt: "2026-06-01T15:30:00.000Z",
      components: ["notification-banner"],
    });
    expect(createPayoutNotificationBannerSession).toHaveBeenCalledWith({ accountId: "acc_seller" });
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
