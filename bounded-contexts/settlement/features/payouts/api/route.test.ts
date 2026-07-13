import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SettlementApiEnv } from "../../../api";
import { createMoneyMovementWebhookRoutes, createPayoutRoutes } from "./route";
import type { PayoutServices } from "./runtime";
import { ProviderWebhookError } from "@chase-sets/http/provider-errors";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_seller" as never,
  },
};

function createAuthenticatedApp(services: unknown, permissions: readonly string[] | null) {
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
      version: 2,
      payout: {
        payout_id: "pyo_test",
        account_id: "acc_seller",
        amount: "12.50",
        currency_code: "usd",
        destination_reference: null,
        note: "Weekly payout",
        status: "in-transit",
        provider_transfer_reference: "tr_test",
        provider_payout_reference: "po_test",
        provider_status: "pending",
        provider_failure_code: null,
        provider_failure_message: null,
        requested_at: "2026-06-01T15:00:00.000Z",
        sent_at: "2026-06-01T15:00:01.000Z",
        completed_at: null,
        failed_at: null,
        failure_reason: null,
        updated_at: "2026-06-01T15:00:01.000Z",
        version: 2,
      },
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
      version: 2,
      status: "in-transit",
      payout: expect.objectContaining({
        payout_id: "pyo_test",
        status: "in-transit",
        provider_payout_reference: "po_test",
      }),
    });
    expect(requestPayout).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        actorUserId: "usr_test",
        amount: "12.50",
        destinationReference: null,
        note: "Weekly payout",
        sensitiveActionToken: null,
      },
      context,
    );
  });

  it("returns a support-safe payout snapshot when provider submission fails", async () => {
    const requestPayout = vi.fn(async () => ({
      payoutId: "pyo_test",
      version: 2,
      payout: {
        payout_id: "pyo_test",
        account_id: "acc_seller",
        amount: "12.50",
        currency_code: "usd",
        destination_reference: null,
        note: null,
        status: "failed",
        provider_transfer_reference: "tr_test",
        provider_payout_reference: null,
        provider_status: "failed",
        provider_failure_code: "bank_account_closed",
        provider_failure_message: "Provider says the bank account is closed.",
        requested_at: "2026-06-01T15:00:00.000Z",
        sent_at: null,
        completed_at: null,
        failed_at: "2026-06-01T15:00:01.000Z",
        failure_reason: "Payout account details need review.",
        updated_at: "2026-06-01T15:00:01.000Z",
        version: 2,
      },
    }));
    const app = createAuthenticatedApp({ requestPayout }, ["payouts.request"]);

    const response = await app.request("/payouts", {
      method: "POST",
      body: JSON.stringify({ amount: "12.50" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      payout: {
        status: "failed",
        failure_reason: "Payout account details need review.",
        provider_failure_code: null,
        provider_failure_message: null,
      },
    });
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

  it("previews payout requests through the payout runtime", async () => {
    const previewPayoutRequest = vi.fn(async () => ({
      account_id: "acc_seller",
      requested_amount: "12.50",
      currency_code: "usd",
      available_balance_amount: "20.00",
      platform_available_amount: "100.00",
      estimated_wallet_balance_after: "7.50",
      can_request: true,
      unavailable_reasons: [],
      unavailable_reason_details: [],
    }));
    const app = createAuthenticatedApp({ previewPayoutRequest }, ["payouts.request"]);

    const response = await app.request("/payouts/preview", {
      method: "POST",
      body: JSON.stringify({ amount: "12.50" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      can_request: true,
      estimated_wallet_balance_after: "7.50",
    });
    expect(previewPayoutRequest).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        amount: "12.50",
      },
      context,
    );
  });

  it("returns payout money timelines for the current account", async () => {
    const getPayoutMoneyTimeline = vi.fn(async () => ({
      payout_id: "pyo_test",
      account_id: "acc_seller",
      items: [
        {
          occurred_at: "2026-04-01T00:00:00.000Z",
          kind: "payout-requested",
          label: "Payout requested",
          reference: "pyo_test",
          amount: "12.50",
          currency_code: "usd",
        },
      ],
    }));
    const app = createAuthenticatedApp({ getPayoutMoneyTimeline }, ["payouts.view"]);

    const response = await app.request("/payouts/pyo_test/timeline");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payout_id: "pyo_test",
      items: [expect.objectContaining({ kind: "payout-requested" })],
    });
    expect(getPayoutMoneyTimeline).toHaveBeenCalledWith({
      payoutId: "pyo_test",
      accountId: "acc_seller",
    });
  });

  it("exposes provider health only to payout reconcilers", async () => {
    const getProviderHealth = vi.fn(async () => ({
      provider_name: "stripe",
      adapter_mode: "provider",
      webhook_signature_required: true,
      platform_balance_supported: true,
      connected_account_payouts_supported: true,
    }));
    const app = createAuthenticatedApp({ getProviderHealth }, ["payouts.reconcile"]);

    const response = await app.request("/provider-health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider_name: "stripe",
      webhook_signature_required: true,
    });
  });

  it("lists provider idempotency keys only for payout reconcilers", async () => {
    const listProviderIdempotencyKeys = vi.fn(async () => [
      {
        operation_key: "payout:pyo_test:payout",
        provider_name: "stripe",
        operation_kind: "connected-account-payout-create",
        account_id: "acc_seller",
        payout_id: "pyo_test",
        provider_object_reference: "po_test",
        idempotency_key: "settlement:payout:pyo_test:payout",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);
    const app = createAuthenticatedApp({ listProviderIdempotencyKeys }, ["payouts.reconcile"]);

    const response = await app.request("/payouts/provider-idempotency?limit=5");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      count: 1,
      items: [expect.objectContaining({ idempotency_key: "settlement:payout:pyo_test:payout" })],
    });
    expect(listProviderIdempotencyKeys).toHaveBeenCalledWith({
      accountId: "acc_seller",
      limit: 5,
    });
  });

  it("queues reconciliation only for payout reconcilers", async () => {
    const enqueuePayoutReconciliationJob = vi.fn(async () => ({
      jobId: "job_reconcile",
      jobKind: "payout-reconciliation",
      status: "queued",
      payload: { accountId: "acc_seller", limit: 25 },
      progress: { phase: "queued", completed: 0, total: 0, message: "Payout reconciliation queued." },
      result: null,
      errorMessage: null,
      eventContext: context,
      claimOwnerId: null,
      claimedUntil: null,
      createdAt: "2026-05-28T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-05-28T00:00:00.000Z",
    }));
    const app = createAuthenticatedApp({ enqueuePayoutReconciliationJob }, ["payouts.reconcile"]);

    const response = await app.request("/payouts/reconciliation/run", {
      method: "POST",
      body: JSON.stringify({ limit: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_reconcile",
      status: "queued",
    });
    expect(enqueuePayoutReconciliationJob).toHaveBeenCalledWith({ limit: 25 }, context);
  });

  it("does not expose reconciliation jobs queued for another account", async () => {
    const getPayoutReconciliationJob = vi.fn(async () => ({
      jobId: "job_other",
      jobKind: "payout-reconciliation",
      status: "queued" as const,
      payload: { accountId: "acc_other", limit: 25 },
      progress: { phase: "queued" as const, completed: 0, total: 0, message: "Payout reconciliation queued." },
      result: null,
      errorMessage: null,
      eventContext: context,
      claimOwnerId: null,
      claimedUntil: null,
      createdAt: "2026-05-28T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-05-28T00:00:00.000Z",
    }));
    const app = createAuthenticatedApp({ getPayoutReconciliationJob }, ["payouts.reconcile"]);

    const response = await app.request("/payouts/reconciliation/jobs/job_other");

    expect(response.status).toBe(404);
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

    const rawBody = '{"type":"payout.failed","data":{"object":{"id":"po_123"}}}';
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
      error: {
        code: "provider_webhook_signature_invalid",
        message: "Stripe webhook signature verification failed.",
        failure_class: "signature-invalid",
        retryable: true,
      },
    });
  });

  it("returns a retryable error when money movement webhook processing fails after verification", async () => {
    const processMoneyMovementWebhook = vi.fn(async () => {
      throw new Error("simulated payout webhook commit conflict");
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
      headers: { "Stripe-Signature": "t=1,v1=abc" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "provider_webhook_handler_failure",
        message: "Provider webhook handler failed.",
        failure_class: "handler-failure",
        retryable: true,
      },
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
      body: '{"type":"unsupported"}',
      headers: { "Stripe-Signature": "t=1,v1=abc" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: true,
    });
  });

  it.each([
    ["unknown-event", "Unknown event"],
    ["schema-mismatch", "Schema mismatch"],
    ["inbox-conflict", "Inbox conflict"],
  ] as const)("acknowledges %s without retrying the delivery", async (failureClass, message) => {
    const processMoneyMovementWebhook = vi.fn(async () => {
      throw new ProviderWebhookError(failureClass, message, "evt_test", "payout.failed", false);
    });
    const app = new Hono().route(
      "/provider",
      createMoneyMovementWebhookRoutes({ processMoneyMovementWebhook } as unknown as PayoutServices),
    );

    const response = await app.request("/provider/money-movement/webhooks", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: true,
      failure_class: failureClass,
    });
  });
});
