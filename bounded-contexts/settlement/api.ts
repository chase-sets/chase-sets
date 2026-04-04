import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { SettlementServices } from "./services";
import { createWalletRoutes } from "./wallets/route";
import { createPayoutRoutes } from "./payouts/route";

export type SettlementApiEnv = AuthenticatedApiEnv;

export function buildSettlementApi(services: SettlementServices) {
  const app = new Hono<SettlementApiEnv>();

  app.route("/", createWalletRoutes(services.wallets));
  app.route("/", createPayoutRoutes(services.payouts));

  return app;
}
