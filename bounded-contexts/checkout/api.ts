import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { CheckoutServices } from "./support/runtime-support/services";
import { createAccountCartRoutes } from "./features/cart/api/route";
import { createAccountCheckoutSessionRoutes } from "./features/sessions/api/route";

export type CheckoutApiEnv = AuthenticatedApiEnv;

export function buildCheckoutApi(services: CheckoutServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.route("/account", createAccountCartRoutes(services.cart));
  app.route("/account", createAccountCheckoutSessionRoutes(services.sessions));

  return app;
}
