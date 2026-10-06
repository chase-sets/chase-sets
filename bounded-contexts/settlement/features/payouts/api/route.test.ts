import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SettlementApiEnv } from "../../../api";
import { createMoneyMovementWebhookRoutes, createPayoutRoutes } from "./route";
import { toPayoutReconciliationJobStatus, type PayoutReconciliationJob, type PayoutServices } from "./runtime";
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
  it("allows platform-only readers to reconcile-read both accounts without claiming payouts", async () => {
    const rows = [{ account_id: "acc_seller" }, { account_id: "acc_other" }];
    const listPayoutsNeedingReconciliation = vi.fn(async ({ accountId }: { accountId: string | null }) =>
      rows.filter((row) => accountId === null || row.account_id === accountId),
    );
    const app = createAuthenticatedApp({ listPayoutsNeedingReconciliation }, ["payouts.platform.view"]);
    const response = await app.request("/payouts/reconciliation?accountId=acc_other&scope=account");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: rows, total: 2, count: 2 });
    expect(listPayoutsNeedingReconciliation).toHaveBeenCalledExactlyOnceWith({
      accountId: null,
      limit: 100,
      filter: null,
    });
  });

  it("submits confirmed payout requests through the payout runtime", async () => {
    const requestPayout = vi.fn(async () => ({
      payoutId: "pyo_test",
      version: 2,
      payout: {
        payout_id: "pyo_test",
        account_id: "acc_seller",
        amount: "12.50",
        requested_amount: "12.50",
        fee_amount: "0.29",
        net_amount: "12.21",
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
        requested_amount: "12.50",
        fee_amount: "0.29",
        net_amount: "12.21",
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
      fee_amount: "0.29",
      net_amount: "12.21",
      monthly_active_fee_amount: "0.00",
      is_first_payout_of_month: true,
      fee_policy_version: "fallback",
      fee_lines: [{ code: "payout-fee", label: "Payout fee", amount: "0.29" }],
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

describe("platform payout read authority", () => {
  const readPaths = [
    "/money-health",
    "/provider-health",
    "/payouts/reconciliation",
    "/payouts/reconciliation/runs",
    "/payouts/platform-balance-forecast",
    "/payouts/reconciliation/jobs/job_other",
    "/payouts/reconciliation/jobs/job_other/events",
  ];

  function job(accountId = "acc_other"): PayoutReconciliationJob {
    return {
      jobId: "job_other",
      jobKind: "payout-reconciliation",
      status: "completed",
      payload: { accountId, limit: 25 },
      progress: { phase: "completed", completed: 2, total: 2, message: null },
      result: { checked: 2, reconciled: 2, ignored: 0, skipped: 0, errors: [] },
      errorMessage: null,
      eventContext: context,
      claimOwnerId: null,
      claimedUntil: null,
      attemptCount: 1,
      nextEligibleAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
      startedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T00:00:01.000Z",
      updatedAt: "2026-10-01T00:00:01.000Z",
    };
  }

  function services() {
    const payouts = [
      { payout_id: "pyo_a", account_id: "acc_seller" },
      { payout_id: "pyo_b", account_id: "acc_other" },
    ];
    const runs = [{ run_id: "run_a" }, { run_id: "run_b" }];
    const forecast = { currency_code: "usd", available_amount: "200.00" };
    const provider = { provider_name: "fake", adapter_mode: "fake" };
    const balances = [{ account_id: "acc_seller" }, { account_id: "acc_other" }];
    return {
      payouts,
      runs,
      forecast,
      provider,
      balances,
      listPayoutsNeedingReconciliation: vi.fn(async ({ accountId }: { accountId: string | null }) =>
        payouts.filter((payout) => accountId === null || payout.account_id === accountId),
      ),
      listReconciliationRuns: vi.fn(async () => runs),
      getPlatformBalanceForecast: vi.fn(async () => forecast),
      getProviderHealth: vi.fn(async () => provider),
      listNegativeBalanceAccounts: vi.fn(async () => ({ items: balances, total: 2 })),
      getPayoutReconciliationJob: vi.fn(async (id: string) => (id === "job_other" ? job() : null)),
      listPayoutReconciliationJobEvents: vi.fn(async (_id: string, after: number) =>
        after < 1 ? [{ sequence: 1, eventName: "status", job: toPayoutReconciliationJobStatus(job()) }] : [],
      ),
      waitForPayoutReconciliationJobEvents: vi.fn(async () => {
        throw new Error("Terminal streams must not wait");
      }),
    };
  }

  it.each(["payouts.platform.view", "payouts.reconcile"])(
    "preserves exact summary scope for %s despite forged parameters",
    async (permission) => {
      const s = services();
      const app = createAuthenticatedApp(s, [permission]);
      const accountId = permission === "payouts.platform.view" ? null : "acc_seller";
      const expectedPayouts = accountId === null ? s.payouts : [s.payouts[0]];
      const query = "?accountId=acc_other&scope=platform&claimOwnerId=forged";
      const health = await app.request(`/money-health${query}`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({
        payouts_needing_attention: expectedPayouts,
        reconciliation_runs: s.runs,
        platform_balance_forecast: s.forecast,
        provider_health: s.provider,
        negative_balance_accounts: s.balances,
        negative_balance_total: 2,
      });
      expect(s.listPayoutsNeedingReconciliation).toHaveBeenCalledExactlyOnceWith({ accountId, limit: 25 });
      expect(s.listReconciliationRuns).toHaveBeenCalledExactlyOnceWith({ limit: 10 });
      expect(s.getPlatformBalanceForecast).toHaveBeenCalledExactlyOnceWith({ currencyCode: "usd" });
      expect(s.getProviderHealth).toHaveBeenCalledExactlyOnceWith();
      expect(s.listNegativeBalanceAccounts).toHaveBeenCalledExactlyOnceWith({ limit: 25 });
      s.listPayoutsNeedingReconciliation.mockClear();
      const list = await app.request(`/payouts/reconciliation${query}&limit=7&filter=failed`);
      await expect(list.json()).resolves.toEqual({
        items: expectedPayouts,
        count: expectedPayouts.length,
        total: expectedPayouts.length,
      });
      expect(s.listPayoutsNeedingReconciliation).toHaveBeenCalledExactlyOnceWith({
        accountId,
        limit: 7,
        filter: "failed",
      });
      for (const [path, expected] of [
        ["/provider-health", s.provider],
        ["/payouts/platform-balance-forecast", s.forecast],
        ["/payouts/reconciliation/runs", { items: s.runs, count: 2, total: 2 }],
      ] as const) {
        const response = await app.request(`${path}${query}`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(expected);
      }
      expect(s.listReconciliationRuns).toHaveBeenLastCalledWith({ limit: 25 });
      expect(s.getPlatformBalanceForecast).toHaveBeenLastCalledWith({ currencyCode: "usd" });
      expect(s.getProviderHealth).toHaveBeenLastCalledWith();
    },
  );

  it.each(readPaths)("denies view-only and signed-out callers to %s before any service", async (path) => {
    for (const permissions of [["payouts.view"], null]) {
      const s = services();
      const response = await createAuthenticatedApp(s, permissions).request(path);
      expect(response.status).toBe(permissions === null ? 401 : 403);
      for (const service of Object.values(s).filter(vi.isMockFunction)) expect(service).not.toHaveBeenCalled();
    }
  });

  it.each(["", "/events"])(
    "keeps missing and foreign job%s indistinguishable for reconcile-only callers",
    async (suffix) => {
      const s = services();
      const app = createAuthenticatedApp(s, ["payouts.reconcile"]);
      const foreign = await app.request(
        `/payouts/reconciliation/jobs/job_other${suffix}?accountId=acc_other&scope=platform`,
      );
      const missing = await app.request(`/payouts/reconciliation/jobs/job_missing${suffix}`);
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
      expect(s.listPayoutReconciliationJobEvents).not.toHaveBeenCalled();
    },
  );

  it("admits the reconcile holder's own job and completed replay", async () => {
    const s = services();
    s.getPayoutReconciliationJob.mockResolvedValue(job("acc_seller"));
    const app = createAuthenticatedApp(s, ["payouts.reconcile"]);
    expect((await app.request("/payouts/reconciliation/jobs/job_other")).status).toBe(200);
    const response = await app.request("/payouts/reconciliation/jobs/job_other/events");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: status");
  });

  it("admits foreign job detail and terminal replay to platform-only readers", async () => {
    const s = services();
    const app = createAuthenticatedApp(s, ["payouts.platform.view"]);
    const response = await app.request("/payouts/reconciliation/jobs/job_other?scope=account");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(toPayoutReconciliationJobStatus(job()));
    const events = await app.request("/payouts/reconciliation/jobs/job_other/events");
    expect(events.status).toBe(200);
    expect(await events.text()).toContain("event: status");
    expect(s.listPayoutReconciliationJobEvents).toHaveBeenCalledExactlyOnceWith("job_other", 0);
    const missing = await app.request("/payouts/reconciliation/jobs/job_missing");
    expect(missing.status).toBe(404);
  });

  it("terminates a foreign terminal stream with a cursor past its last event using platform snapshot authority", async () => {
    const s = services();
    const response = await createAuthenticatedApp(s, ["payouts.platform.view"]).request(
      "/payouts/reconciliation/jobs/job_other/events",
      { headers: { "Last-Event-ID": "50" } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(s.listPayoutReconciliationJobEvents).toHaveBeenCalledExactlyOnceWith("job_other", 50);
    expect(s.getPayoutReconciliationJob).toHaveBeenCalledTimes(2);
    expect(s.waitForPayoutReconciliationJobEvents).not.toHaveBeenCalled();
  });

  it("terminates replay backpressure with the foreign platform-authorized snapshot", async () => {
    const s = services();
    s.listPayoutReconciliationJobEvents.mockResolvedValue(
      Array.from({ length: 251 }, (_, index) => ({
        sequence: index + 1,
        eventName: "status",
        job: { ...toPayoutReconciliationJobStatus(job()), status: "running" },
      })),
    );
    const response = await createAuthenticatedApp(s, ["payouts.platform.view"]).request(
      "/payouts/reconciliation/jobs/job_other/events",
    );
    expect(response.status).toBe(200);
    const replay = await response.text();
    expect(replay).toContain("event: sync.required");
    expect(replay).toContain(
      JSON.stringify({
        kind: "sync.required",
        reason: "replay-backpressure",
        snapshot: toPayoutReconciliationJobStatus(job()),
      }),
    );
    expect(s.getPayoutReconciliationJob).toHaveBeenCalledTimes(2);
    expect(s.waitForPayoutReconciliationJobEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/payouts/reconciliation/run", "enqueuePayoutReconciliationJob"],
    ["POST", "/payouts/preview", "previewPayoutRequest"],
    ["POST", "/payouts", "requestPayout"],
    ["GET", "/payouts/provider-idempotency", "listProviderIdempotencyKeys"],
    ["GET", "/payouts", "listPayouts"],
    ["GET", "/payouts/pyo_other", "getPayout"],
    ["GET", "/payouts/pyo_other/timeline", "getPayoutMoneyTimeline"],
  ])("denies platform-only readers %s %s without invoking %s", async (method, path, serviceName) => {
    const service = vi.fn();
    const response = await createAuthenticatedApp({ [serviceName]: service }, ["payouts.platform.view"]).request(path, {
      method,
    });
    expect(response.status).toBe(403);
    expect(service).not.toHaveBeenCalled();
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
