import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { OrderingServices } from "./services";
import { createBuyerCartRoutes } from "./cart/route";
import {
  createBuyerOrderRoutes,
  createSellerOrderRoutes,
} from "./orders/route";

export type OrderingApiEnv = AuthenticatedApiEnv;

async function drainProjectors(services: OrderingServices) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function buildOrderingApi(services: OrderingServices) {
  const app = new Hono<OrderingApiEnv>();

  app.use("*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors(services);
    }
  });

  app.route("/buyer", createBuyerCartRoutes(services.cart));
  app.route("/buyer", createBuyerOrderRoutes(services.orders));
  app.route("/seller", createSellerOrderRoutes(services.orders));

  return app;
}
