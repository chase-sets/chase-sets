import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { FulfillmentServices } from "./services";
import {
  createBuyerShipmentRoutes,
  createSellerShipmentRoutes,
} from "./shipments/route";

export type FulfillmentApiEnv = AuthenticatedApiEnv;

async function drainProjectors(services: FulfillmentServices) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function buildFulfillmentApi(services: FulfillmentServices) {
  const app = new Hono<FulfillmentApiEnv>();

  app.use("*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors(services);
    }
  });

  app.route("/buyer", createBuyerShipmentRoutes(services.shipments));
  app.route("/seller", createSellerShipmentRoutes(services.shipments));

  return app;
}
