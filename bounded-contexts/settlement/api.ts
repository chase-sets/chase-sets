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
