import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createCommercialTermsResolver,
  type CommercialTermsResolver,
} from "@chase-sets/commercial-terms/server";
import type { OrderingServices } from "./support/runtime-support/services";
import {
  createAccountPurchaseOrderRoutes,
  createAccountSaleOrderRoutes,
} from "./features/orders/api/route";

export type OrderingApiEnv = AuthenticatedApiEnv;

export type { CommercialTermsResolver };

export function createOrderingCommercialTermsResolver(
  db: PgQueryable,
): CommercialTermsResolver {
  return createCommercialTermsResolver({ db });
}

export function buildOrderingApi(services: OrderingServices) {
  const app = new Hono<OrderingApiEnv>();

  app.route("/account", createAccountPurchaseOrderRoutes(services.orders));
  app.route("/account", createAccountSaleOrderRoutes(services.orders));

  return app;
}
