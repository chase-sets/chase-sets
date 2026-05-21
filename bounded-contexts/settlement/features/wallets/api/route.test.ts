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

function createApp(services: Partial<WalletServices>, permissions: readonly string[] | null) {
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
    const app = createApp({ postEntry }, ["payouts.manage"]);

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
    const postEntry = vi.fn(async () => ({ accountId: "acc_seller", version: 2 }));
    const app = createApp({ postEntry }, ["payouts.manage"]);
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
    expect(postEntry.mock.calls[0]?.[0].ledgerEntryId).toBe(postEntry.mock.calls[1]?.[0].ledgerEntryId);
  });

  it("treats duplicate dispute holds as idempotent retries", async () => {
    const postEntry = vi
      .fn()
      .mockResolvedValueOnce({ accountId: "acc_seller", version: 2 })
      .mockRejectedValueOnce(new Error("Ledger entry has already been posted."));
    const app = createApp({ postEntry }, ["payouts.manage"]);
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
    expect(postEntry.mock.calls[0]?.[0].ledgerEntryId).toBe(postEntry.mock.calls[1]?.[0].ledgerEntryId);
  });

  it("posts dispute releases as credits with required operator audit", async () => {
    const postEntry = vi.fn(async () => ({ accountId: "acc_seller", version: 3 }));
    const app = createApp({ postEntry }, ["payouts.manage"]);

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
