import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { SettlementServices } from "./support/runtime-support/services";
import { createWalletRoutes } from "./features/wallets/api/route";
import {
  createMoneyMovementWebhookRoutes,
  createPayoutRoutes,
} from "./features/payouts/api/route";
import { createPayoutReadinessRoutes } from "./features/payout-readiness/api/route";

export type SettlementApiEnv = AuthenticatedApiEnv;

export function buildSettlementApi(services: SettlementServices) {
  const app = new Hono<SettlementApiEnv>();

  app.get("/account-status", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }
    if (!actor.permissions.includes("payouts.view")) {
      return c.json({ error: "Forbidden." }, 403);
    }

    const [wallet, payoutReadiness] = await Promise.all([
      services.wallets.getWallet(actor.accountId),
      services.payoutReadiness.getPayoutReadiness(actor.accountId),
    ]);
    const availableAmount = Number.parseFloat(wallet.available_balance_amount);
    const setupReady = payoutReadiness.status === "ready";
    const restrictions = [
      ...(setupReady ? [] : ["payout-setup-incomplete"]),
      ...(payoutReadiness.missing_requirements.length > 0
        ? ["provider-requirements-open"]
        : []),
      ...(availableAmount > 0 ? [] : ["no-available-wallet-balance"]),
    ];

    return c.json({
      account_id: actor.accountId,
      wallet: {
        currency_code: wallet.currency_code,
        pending_balance_amount: wallet.pending_balance_amount,
        available_balance_amount: wallet.available_balance_amount,
        can_use_balance_credit: availableAmount > 0,
      },
      payout_setup: {
        status: payoutReadiness.status,
        ready: setupReady,
        onboarding_status: payoutReadiness.onboarding_status,
        transfer_capability_status: payoutReadiness.transfer_capability_status,
        payout_capability_status: payoutReadiness.payout_capability_status,
        payout_destination_status: payoutReadiness.payout_destination_status,
        missing_requirements: payoutReadiness.missing_requirements,
        last_checked_at: payoutReadiness.updated_at,
      },
      payouts: {
        can_request: setupReady && availableAmount > 0,
        unavailable_reasons: restrictions,
      },
      restrictions,
      next_actions: [
        ...(!setupReady ? ["finish-payout-setup"] : []),
        ...(setupReady && availableAmount > 0 ? ["request-payout"] : []),
      ],
    });
  });

  app.route("/", createWalletRoutes(services.wallets));
  app.route("/", createPayoutReadinessRoutes(services.payoutReadiness));
  app.route("/", createPayoutRoutes(services.payouts));

  return app;
}

export function buildSettlementMoneyMovementWebhookApi(
  services: SettlementServices,
) {
  return createMoneyMovementWebhookRoutes(services.payouts);
}
