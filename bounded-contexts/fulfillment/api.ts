import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { FulfillmentServices } from "./services";
import {
  createBuyerShipmentRoutes,
  createSellerShipmentRoutes,
} from "./shipments/route";

export type FulfillmentApiEnv = AuthenticatedApiEnv;

export function buildFulfillmentApi(services: FulfillmentServices) {
  const app = new Hono<FulfillmentApiEnv>();

  app.route("/buyer", createBuyerShipmentRoutes(services.shipments));
  app.route("/seller", createSellerShipmentRoutes(services.shipments));

  return app;
}
