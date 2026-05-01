import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PaymentsApiEnv } from "./route";
import {
  createAccountPaymentRoutes,
  createPaymentProcessorWebhookRoutes,
} from "./route";
import type { PaymentServices } from "./runtime";

function buildAccountApp(options: Readonly<{
  actor: PaymentsApiEnv["Variables"]["actor"];
  services: PaymentServices;
}>) {
  const app = new Hono<PaymentsApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/account", createAccountPaymentRoutes(options.services));

  return app;
}

function createServices(): PaymentServices {
  return {
    commandHandler: vi.fn(async () => ({
      state: {} as never,
      version: 1,
      newEvents: [],
      storedEvents: [],
    })),
    createAccountPayment: vi.fn(async () => ({
      payment_id: "pay_1",
      buyer_account_id: "acc_buyer",
      order_ids: ["ord_1"],
      amount: "24.99",
      balance_credit_amount: "0.00",
      processor_amount: "24.99",
      currency_code: "usd",
      processor_name: "stripe",
      processor_payment_reference: "pi_1",
      processor_client_secret: "pi_1_secret_1",
      processor_status: "requires_payment_method",
      status: "pending-confirmation",
      failure_code: null,
      failure_message: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      captured_at: null,
      failed_at: null,
      cancelled_at: null,
      processor_publishable_key: "pk_test_123",
    })),
    getAccountPayment: vi.fn(async () => null),
    processWebhook: vi.fn(async () => ({ received: true, ignored: false })),
    publicConfig: { processorName: "stripe", publishableKey: "pk_test_123" },
    projectors: [],
  };
}

describe("payments routes", () => {
  it("creates an account payment for the current account", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ["ord_1"] }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
    });
    expect(services.createAccountPayment).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        orderIds: ["ord_1"],
        currencyCode: "usd",
        requestedBalanceCreditAmount: null,
      },
      expect.any(Object),
    );
  });

  it("passes checkout source metadata into account payment creation", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: ["ord_1"],
          sourceContext: "checkout",
          sourceReferenceId: "chk_1",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createAccountPayment).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        orderIds: ["ord_1"],
        currencyCode: "usd",
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
        requestedBalanceCreditAmount: null,
      },
      expect.any(Object),
    );
  });

  it("passes requested balance credit into account payment creation", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: ["ord_1"],
          requestedBalanceCreditAmount: "7.25",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createAccountPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBalanceCreditAmount: "7.25",
      }),
      expect.any(Object),
    );
  });

  it("rejects account payment creation without order permissions", async () => {
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["orders.view"],
      },
      services: createServices(),
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ["ord_1"] }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
  });

  it("accepts provider webhooks without marketplace auth context", async () => {
    const services = createServices();
    const app = new Hono().route("/provider", createPaymentProcessorWebhookRoutes(services));

    const response = await app.fetch(
      new Request("http://payments.test/provider/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_1" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, ignored: false });
    expect(services.processWebhook).toHaveBeenCalled();
  });
});
