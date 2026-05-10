import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { OrderingServices } from "./support/runtime-support/services";
import {
  createAccountPurchaseOrderRoutes,
  createAccountSaleOrderRoutes,
} from "./features/orders/api/route";
import { createAccountOrderNotificationRoutes } from "./features/orders/api/notification-routes";

export type OrderingApiEnv = AuthenticatedApiEnv;

export function buildOrderingApi(services: OrderingServices) {
  const app = new Hono<OrderingApiEnv>();

  app.route("/account", createAccountPurchaseOrderRoutes(services.orders));
  app.route("/account", createAccountSaleOrderRoutes(services.orders));
  app.route("/account", createAccountOrderNotificationRoutes(services.notifications));

  return app;
}
