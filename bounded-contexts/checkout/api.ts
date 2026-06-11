import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { CheckoutServices } from "./support/runtime-support/services";
import { createAccountCartRoutes, createGuestCartRoutes } from "./features/cart/api/route";
import { createAccountSellListRoutes, createGuestSellListRoutes } from "./features/sell-list/api/route";
import { createAccountCheckoutSessionRoutes } from "./features/sessions/api/route";

export type CheckoutApiEnv = AuthenticatedApiEnv;

export function buildCheckoutApi(services: CheckoutServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.route("/account", createAccountCartRoutes(services.cart, services.checkoutObservabilityTelemetry));
  app.route("/account", createAccountSellListRoutes(services.sellList));
  app.route("/account", createAccountCheckoutSessionRoutes(services.sessions, services.checkoutObservabilityTelemetry));
  app.route("/guest", createGuestCartRoutes(services.cart, services.checkoutObservabilityTelemetry));
  app.route("/guest", createGuestSellListRoutes(services.sellList));

  return app;
}
