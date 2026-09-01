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

describe("settlement account-facing Wallet Adjustment detail route", () => {
  it("returns the redacted adjustment when it belongs to the caller's own account", async () => {
    const getWalletAdjustmentForAccount = vi.fn(async () => ({
      status: "posted" as const,
      display_reference: "WAD-A1B2C3D4",
      direction: "credit" as const,
      amount: "40.00",
      currency_code: "usd",
      reason_code: "goodwill-cash-credit",
      requested_at: "2026-07-10T00:00:00.000Z",
      posted_at: "2026-07-10T02:00:00.000Z",
      available_balance_before: "10.00",
      available_balance_after: "50.00",
      reversed_at: null,
      reversal_of_display_reference: null,
      reversed_by_display_reference: null,
    }));
    const app = createApp({ getWalletAdjustmentForAccount }, ["payouts.view"]);

    const response = await app.request("/wallet/adjustments/WAD-A1B2C3D4");

    expect(response.status).toBe(200);
    expect(getWalletAdjustmentForAccount).toHaveBeenCalledWith({
      reference: "WAD-A1B2C3D4",
      accountId: "acc_operator",
    });
    const body = await response.json();
    expect(body.display_reference).toBe("WAD-A1B2C3D4");
    expect(body).not.toHaveProperty("adjustment_id");
    expect(body).not.toHaveProperty("explanation");
    expect(body).not.toHaveProperty("evidence_references");
    expect(body).not.toHaveProperty("posted_ledger_entry_id");
  });

  it("returns 404 rather than distinguishing another account's adjustment from a nonexistent one", async () => {
    const getWalletAdjustmentForAccount = vi.fn(async () => null);
    const app = createApp({ getWalletAdjustmentForAccount }, ["payouts.view"]);

    const response = await app.request("/wallet/adjustments/WAD-NOT-MINE");

    expect(response.status).toBe(404);
  });

  it("requires authentication", async () => {
    const getWalletAdjustmentForAccount = vi.fn();
    const app = createApp({ getWalletAdjustmentForAccount }, null);

    const response = await app.request("/wallet/adjustments/WAD-A1B2C3D4");

    expect(response.status).toBe(401);
    expect(getWalletAdjustmentForAccount).not.toHaveBeenCalled();
  });
});
