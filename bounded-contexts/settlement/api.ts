import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { SettlementServices } from "./support/runtime-support/services";
import { createWalletRoutes } from "./features/wallets/api/route";
import { createWalletAdjustmentRoutes } from "./features/wallets/api/wallet-adjustment-route";
import { createClearancePolicyRoutes } from "./features/wallets/api/clearance-policy-route";
import { createMoneyMovementWebhookRoutes, createPayoutRoutes } from "./features/payouts/api/route";
import { createPayoutBoundsPolicyRoutes } from "./features/payouts/api/payout-bounds-policy-route";
import { createPayoutReadinessRoutes } from "./features/payout-readiness/api/route";
import { payoutUnavailableReasonLabel } from "./features/payouts/domain/reason-codes";
import { buildPayoutSetupProgress } from "./features/payout-readiness/domain/setup-progress";

export type SettlementApiEnv = AuthenticatedApiEnv;

export function buildSettlementApi(services: SettlementServices) {
  const app = new Hono<SettlementApiEnv>();

  app.get("/account-status", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required.",
          },
        },
        401,
      );
    }
    if (!actor.permissions.includes("payouts.view")) {
      return c.json(
        {
          error: {
            code: "authorization_forbidden",
            message: "Forbidden.",
          },
        },
        403,
      );
    }

    const [wallet, payoutReadiness] = await Promise.all([
      services.wallets.getWallet(actor.accountId),
      services.payoutReadiness.getPayoutReadiness(actor.accountId),
    ]);
    const availableAmount = Number.parseFloat(wallet.available_balance_amount);
    const setupReady = payoutReadiness.status === "ready";
    const setupStale =
      !payoutReadiness.updated_at || Date.now() - Date.parse(payoutReadiness.updated_at) > 24 * 60 * 60 * 1000;
    const restrictions = [
      ...(setupReady ? [] : ["payout-setup-incomplete"]),
      ...(setupReady && setupStale ? ["payout-setup-refresh-required"] : []),
      ...(payoutReadiness.missing_requirements.length > 0 ? ["provider-requirements-open"] : []),
      ...(availableAmount > 0 ? [] : ["no-available-wallet-balance"]),
    ];
    const payoutSetupProgress = buildPayoutSetupProgress(payoutReadiness);

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
        advisory_requirements: payoutReadiness.advisory_requirements,
        disabled_reason: payoutReadiness.disabled_reason,
        requirements_deadline: payoutReadiness.requirements_deadline,
        last_checked_at: payoutReadiness.updated_at,
        steps: payoutSetupProgress.steps,
      },
      payouts: {
        can_request: setupReady && !setupStale && availableAmount > 0,
        unavailable_reasons: restrictions,
        unavailable_reason_details: restrictions.map((code) => ({
          code,
          message: payoutUnavailableReasonLabel(code),
        })),
      },
      restrictions,
      next_actions: [
        ...(!setupReady ? ["finish-payout-setup"] : []),
        ...(setupReady && availableAmount > 0 ? ["request-payout"] : []),
      ],
    });
  });

  app.route("/", createWalletRoutes(services.wallets));
  app.route("/", createWalletAdjustmentRoutes(services.walletAdjustments, services.wallets));
  app.route("/", createPayoutReadinessRoutes(services.payoutReadiness));
  app.route("/", createPayoutRoutes(services.payouts));
  app.route("/clearance-policy", createClearancePolicyRoutes(services.policies));
  app.route("/payout-bounds-policy", createPayoutBoundsPolicyRoutes(services.policies));

  return app;
}

export function buildSettlementMoneyMovementWebhookApi(services: SettlementServices) {
  return createMoneyMovementWebhookRoutes(services.payouts);
}
