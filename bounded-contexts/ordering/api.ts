import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createCommercialTermsResolver,
  type CommercialTermsResolver,
} from "@chase-sets/commercial-terms/server";
import type { OrderingServices } from "./support/runtime-support/services";
import { createBuyerCartRoutes } from "./features/cart/api/route";
import {
  createBuyerOrderRoutes,
  createSellerOrderRoutes,
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

  app.route("/buyer", createBuyerCartRoutes(services.cart));
  app.route("/buyer", createBuyerOrderRoutes(services.orders));
  app.route("/seller", createSellerOrderRoutes(services.orders));

  return app;
}
