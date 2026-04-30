import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { CheckoutServices } from "./support/runtime-support/services";
import { createBuyerCartRoutes } from "./features/cart/api/route";
import { createBuyerCheckoutSessionRoutes } from "./features/sessions/api/route";

export type CheckoutApiEnv = AuthenticatedApiEnv;

export function buildCheckoutApi(services: CheckoutServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.route("/buyer", createBuyerCartRoutes(services.cart));
  app.route("/buyer", createBuyerCheckoutSessionRoutes(services.sessions));

  return app;
}
