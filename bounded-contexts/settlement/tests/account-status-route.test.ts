import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildSettlementApi, type SettlementApiEnv } from "../api";
import type { SettlementServices } from "../support/runtime-support/services";

describe("account status route", () => {
  it.each([
    { amount: "0.00", payable: false },
    { amount: "-5.00", payable: false },
    { amount: "0.01", payable: true },
  ])("gates payout availability on exact signed balance comparison: $amount", async ({ amount, payable }) => {
    const getWallet = vi.fn(async () => ({
      currency_code: "usd",
      pending_balance_amount: "0.00",
      available_balance_amount: amount,
    }));
    const getPayoutReadiness = vi.fn(async () => ({
      status: "ready",
      missing_requirements: [],
      advisory_requirements: [],
      onboarding_status: "complete",
      transfer_capability_status: "active",
      payout_capability_status: "active",
      payout_destination_status: "ready",
      updated_at: new Date().toISOString(),
    }));
    const services = {
      wallets: { getWallet },
      payoutReadiness: { getPayoutReadiness },
    } as unknown as SettlementServices;
    const app = new Hono<SettlementApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "session-1",
        tenantId: "tenant-1",
        userId: "user-1",
        accountId: "acct-1",
        membershipId: "membership-1",
        roleKey: "account-owner",
        permissions: ["payouts.view"],
      });
      await next();
    });
    app.route("/", buildSettlementApi(services));

    const response = await app.request("/account-status");
    expect(response.status).toBe(200);
    const result = await response.json();
    const restrictions = payable ? [] : ["no-available-wallet-balance"];
    expect(result.wallet.can_use_balance_credit).toBe(payable);
    expect(result.payouts.can_request).toBe(payable);
    expect(result.restrictions).toEqual(restrictions);
    expect(result.payouts.unavailable_reasons).toEqual(restrictions);
    expect(result.payouts.unavailable_reason_details.map((reason: { code: string }) => reason.code)).toEqual(
      restrictions,
    );
    expect(result.next_actions).toEqual(payable ? ["request-payout"] : []);
    expect(getWallet).toHaveBeenCalledWith("acct-1");
    expect(getPayoutReadiness).toHaveBeenCalledWith("acct-1");
  });
});
