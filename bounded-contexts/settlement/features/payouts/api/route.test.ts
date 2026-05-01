import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SettlementApiEnv } from "../../../api";
import { createMoneyMovementWebhookRoutes, createPayoutRoutes } from "./route";
import type { PayoutServices } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_seller" as never,
  },
};

function createAuthenticatedApp(
  services: Partial<PayoutServices>,
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
  app.route("/", createPayoutRoutes(services as PayoutServices));
  return app;
}

describe("settlement payout routes", () => {
  it("submits confirmed payout requests through the payout runtime", async () => {
    const requestPayout = vi.fn(async () => ({
      payoutId: "pyo_test",
      version: 1,
    }));
    const app = createAuthenticatedApp({ requestPayout }, ["payouts.request"]);

    const response = await app.request("/payouts", {
      method: "POST",
      body: JSON.stringify({
        amount: "12.50",
        note: "Weekly payout",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "pyo_test",
      version: 1,
    });
    expect(requestPayout).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        amount: "12.50",
        destinationReference: null,
        note: "Weekly payout",
      },
      context,
    );
  });

  it("requires payout request permission before requesting payouts", async () => {
    const requestPayout = vi.fn();
    const app = createAuthenticatedApp({ requestPayout }, ["payouts.view"]);

    const response = await app.request("/payouts", {
      method: "POST",
      body: JSON.stringify({ amount: "12.50" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(requestPayout).not.toHaveBeenCalled();
  });

  it("runs reconciliation only for payout reconcilers", async () => {
    const reconcilePayoutsNeedingAttention = vi.fn(async () => ({
      checked: 1,
      reconciled: 1,
      ignored: 0,
      skipped: 0,
      errors: [],
    }));
    const app = createAuthenticatedApp(
      { reconcilePayoutsNeedingAttention },
      ["payouts.reconcile"],
    );

    const response = await app.request("/payouts/reconciliation/run", {
      method: "POST",
      body: JSON.stringify({ limit: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      ignored: 0,
      skipped: 0,
      errors: [],
    });
    expect(reconcilePayoutsNeedingAttention).toHaveBeenCalledWith(
      { limit: 25 },
      context,
    );
  });
});

describe("settlement money movement webhook route", () => {
  it("accepts provider webhooks without marketplace auth context and preserves the raw body", async () => {
    const processMoneyMovementWebhook = vi.fn(async () => ({
      received: true,
      ignored: false,
    }));
    const app = new Hono().route(
      "/provider",
      createMoneyMovementWebhookRoutes({
        processMoneyMovementWebhook,
      } as unknown as PayoutServices),
    );

    const rawBody = "{\"type\":\"payout.failed\",\"data\":{\"object\":{\"id\":\"po_123\"}}}";
    const response = await app.request("/provider/money-movement/webhooks", {
      method: "POST",
      body: rawBody,
      headers: { "Stripe-Signature": "t=1,v1=abc" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: false,
    });
    expect(processMoneyMovementWebhook).toHaveBeenCalledWith(
      {
        rawBody,
        signatureHeader: "t=1,v1=abc",
      },
      expect.objectContaining({
        tenantId: "tnt_identity",
      }),
    );
  });

  it("returns a bad request when provider signature verification fails", async () => {
    const processMoneyMovementWebhook = vi.fn(async () => {
      throw new Error("Stripe webhook signature verification failed.");
    });
    const app = new Hono().route(
      "/provider",
      createMoneyMovementWebhookRoutes({
        processMoneyMovementWebhook,
      } as unknown as PayoutServices),
    );

    const response = await app.request("/provider/money-movement/webhooks", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe webhook signature verification failed.",
    });
  });

  it("returns ignored responses for unsupported provider events", async () => {
    const processMoneyMovementWebhook = vi.fn(async () => ({
      received: true,
      ignored: true,
    }));
    const app = new Hono().route(
      "/provider",
      createMoneyMovementWebhookRoutes({
        processMoneyMovementWebhook,
      } as unknown as PayoutServices),
    );

    const response = await app.request("/provider/money-movement/webhooks", {
      method: "POST",
      body: "{\"type\":\"unsupported\"}",
      headers: { "Stripe-Signature": "t=1,v1=abc" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: true,
    });
  });
});
