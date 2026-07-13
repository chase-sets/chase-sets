import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SettlementApiEnv } from "../../../api";
import { createWalletRoutes } from "./route";
import type { WalletServices } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_operator" as never,
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
            accountId: "acc_operator",
            membershipId: "mem_test",
            roleKey: "operator",
            permissions,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", createWalletRoutes(services as WalletServices));
  return app;
}

describe("settlement wallet routes", () => {
  it("requires explicit account, idempotency key, and audit reason for refund debits", async () => {
    const postEntry = vi.fn();
    const app = createApp({ postEntry }, ["wallet-adjustments.operate"]);

    const response = await app.request("/wallet/refund-debits", {
      method: "POST",
      body: JSON.stringify({
        amount: "4.00",
        idempotencyKey: "refund:pay_1:4.00",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "Target account is required for operator wallet commands.",
      },
    });
    expect(postEntry).not.toHaveBeenCalled();
  });

  it("posts refund debits to the requested seller account with a deterministic ledger entry", async () => {
    const postEntry = vi.fn(async (params: Record<string, unknown>) => ({
      accountId: "acc_seller" as never,
      version: 2,
      entry: {
        ledger_entry_id: params.ledgerEntryId,
        account_id: params.accountId,
        kind: params.kind,
        direction: params.direction,
        amount: params.amount,
        currency_code: params.currencyCode,
        funds_status: params.fundsStatus,
        order_id: null,
        payment_id: params.paymentId,
        payout_id: null,
        description: params.description,
        posted_at: params.postedAt,
        available_at: null,
        updated_at: params.postedAt,
      },
    }));
    const app = createApp({ postEntry }, ["wallet-adjustments.operate"]);
    const body = {
      accountId: "acc_seller",
      amount: "4.00",
      paymentId: "pay_1",
      idempotencyKey: "refund:pay_1:4.00",
      auditReason: "Customer refund approved",
    };

    const first = await app.request("/wallet/refund-debits", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const second = await app.request("/wallet/refund-debits", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      accountId: "acc_seller",
      version: 2,
      entry: {
        account_id: "acc_seller",
        kind: "refund",
        direction: "debit",
        amount: "4.00",
        payment_id: "pay_1",
        description: "Seller refund debit (Customer refund approved)",
      },
    });
    expect(second.status).toBe(201);
    expect(postEntry).toHaveBeenCalledTimes(2);
    expect(postEntry.mock.calls[0]?.[0]).toMatchObject({
      accountId: "acc_seller",
      kind: "refund",
      direction: "debit",
      amount: "4.00",
      paymentId: "pay_1",
      description: "Seller refund debit (Customer refund approved)",
    });
    const firstEntry = postEntry.mock.calls[0]?.[0] as { ledgerEntryId: string } | undefined;
    const secondEntry = postEntry.mock.calls[1]?.[0] as { ledgerEntryId: string } | undefined;
    expect(firstEntry?.ledgerEntryId).toBe(secondEntry?.ledgerEntryId);
    expect(firstEntry?.ledgerEntryId).toMatch(/^led_[a-f0-9]{26}$/);
  });

  it("derives unique ledger entry ids across distinct operator idempotency keys", async () => {
    const ledgerEntryIds = new Set<string>();
    const postEntry = vi.fn(async (params: { ledgerEntryId: string }) => {
      ledgerEntryIds.add(params.ledgerEntryId);
      return {
        accountId: "acc_seller" as never,
        version: ledgerEntryIds.size + 1,
        entry: {
          ledger_entry_id: params.ledgerEntryId,
        },
      };
    });
    const app = createApp({ postEntry }, ["wallet-adjustments.operate"]);
    const idempotencyKeys = Array.from(
      { length: 2048 },
      (_, index) => `operator-wallet-command:${index.toString(36).padStart(6, "0")}:refund:${index % 17}`,
    );

    for (const idempotencyKey of idempotencyKeys) {
      const response = await app.request("/wallet/refund-debits", {
        method: "POST",
        body: JSON.stringify({
          accountId: "acc_seller",
          amount: "1.00",
          paymentId: "pay_1",
          idempotencyKey,
          auditReason: "Uniqueness regression",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(201);
    }

    expect(postEntry).toHaveBeenCalledTimes(idempotencyKeys.length);
    expect(ledgerEntryIds.size).toBe(idempotencyKeys.length);
  });

  it("treats duplicate dispute holds as idempotent retries", async () => {
    const postEntry = vi
      .fn(async (_params: unknown) => ({ accountId: "acc_seller" as never, version: 2 }))
      .mockResolvedValueOnce({ accountId: "acc_seller" as never, version: 2 })
      .mockRejectedValueOnce(new Error("Ledger entry has already been posted."));
    const app = createApp({ postEntry }, ["wallet-adjustments.operate"]);
    const body = {
      accountId: "acc_seller",
      amount: "8.00",
      paymentId: "pay_1",
      idempotencyKey: "dispute:pay_1:hold:8.00",
      auditReason: "Dispute opened",
    };

    const first = await app.request("/wallet/dispute-holds", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const second = await app.request("/wallet/dispute-holds", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      idempotent: true,
      duplicate: true,
    });
    const firstEntry = postEntry.mock.calls[0]?.[0] as { ledgerEntryId: string } | undefined;
    const secondEntry = postEntry.mock.calls[1]?.[0] as { ledgerEntryId: string } | undefined;
    expect(firstEntry?.ledgerEntryId).toBe(secondEntry?.ledgerEntryId);
  });

  it("posts dispute releases as credits with required operator audit", async () => {
    const postEntry = vi.fn(async (_params: unknown) => ({ accountId: "acc_seller" as never, version: 3 }));
    const app = createApp({ postEntry }, ["wallet-adjustments.operate"]);

    const response = await app.request("/wallet/dispute-releases", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acc_seller",
        amount: "8.00",
        paymentId: "pay_1",
        idempotencyKey: "dispute:pay_1:release:8.00",
        auditReason: "Dispute closed in seller favor",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        kind: "adjustment",
        direction: "credit",
        description: "Dispute hold released (Dispute closed in seller favor)",
      }),
      context,
    );
  });
});

const OPERATOR_WALLET_MUTATION_ROUTES = [
  "/wallet/adjustments",
  "/wallet/refund-debits",
  "/wallet/dispute-holds",
  "/wallet/dispute-releases",
] as const;

describe("settlement wallet operator-mutation authorization", () => {
  it("rejects account-scoped payouts.manage actors on every operator wallet-mutation route", async () => {
    // Owner and manager hold payouts.manage. The arbitrary-account self-credit
    // exploit is closed by requiring the separate platform wallet-adjustment
    // authority, which payouts.manage does not grant.
    for (const route of OPERATOR_WALLET_MUTATION_ROUTES) {
      const postEntry = vi.fn();
      const app = createApp({ postEntry }, ["payouts.manage"]);

      const response = await app.request(route, {
        method: "POST",
        body: JSON.stringify({
          accountId: "acc_operator",
          workflow: "dispute-release",
          amount: "1000.00",
          idempotencyKey: `exploit:${route}`,
          auditReason: "attempted self-credit",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "authorization_forbidden" },
      });
      expect(postEntry).not.toHaveBeenCalled();
    }
  });

  it("cannot mint credit to its own account with workflow=dispute-release", async () => {
    const postEntry = vi.fn();
    // Self-credit: the caller targets its own account with the credit workflow.
    const app = createApp({ postEntry }, ["payouts.manage"]);

    const response = await app.request("/wallet/adjustments", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acc_operator",
        workflow: "dispute-release",
        amount: "500.00",
        idempotencyKey: "self-credit:acc_operator",
        auditReason: "self credit",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(postEntry).not.toHaveBeenCalled();
  });

  it("rejects target-account substitution before the request body is read", async () => {
    const postEntry = vi.fn();
    // A payouts.manage actor substituting an arbitrary target account is denied
    // at authorization, so the untrusted body is never used to post an entry.
    const app = createApp({ postEntry }, ["payouts.manage"]);

    const response = await app.request("/wallet/dispute-releases", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acc_victim",
        amount: "9999.00",
        idempotencyKey: "substitute:acc_victim",
        auditReason: "cross-account substitution",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(postEntry).not.toHaveBeenCalled();
  });

  it("does not let platform payout viewers reach the operator wallet-mutation routes", async () => {
    for (const route of OPERATOR_WALLET_MUTATION_ROUTES) {
      const postEntry = vi.fn();
      const app = createApp({ postEntry }, ["payouts.view", "payouts.reconcile"]);

      const response = await app.request(route, {
        method: "POST",
        body: JSON.stringify({ accountId: "acc_seller", amount: "1.00" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(403);
      expect(postEntry).not.toHaveBeenCalled();
    }
  });

  it("keeps unauthenticated operator wallet-mutation requests at 401", async () => {
    for (const route of OPERATOR_WALLET_MUTATION_ROUTES) {
      const postEntry = vi.fn();
      const app = createApp({ postEntry }, null);

      const response = await app.request(route, {
        method: "POST",
        body: JSON.stringify({ accountId: "acc_seller", amount: "1.00" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "authentication_required" },
      });
      expect(postEntry).not.toHaveBeenCalled();
    }
  });

  it("still admits an explicit wallet-adjustment authority holder", async () => {
    const postEntry = vi.fn(async () => ({ accountId: "acc_seller" as never, version: 2 }));
    const app = createApp({ postEntry }, ["wallet-adjustments.operate"]);

    const response = await app.request("/wallet/dispute-releases", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acc_seller",
        amount: "8.00",
        idempotencyKey: "authorized:acc_seller",
        auditReason: "authorized operator credit",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(postEntry).toHaveBeenCalledTimes(1);
  });
});
