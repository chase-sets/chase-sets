import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { FulfillmentServices } from "./support/runtime-support/services";
import {
  createAccountShipmentRoutes,
  createAccountSaleShipmentRoutes,
} from "./features/shipments/api/route";

export type FulfillmentApiEnv = AuthenticatedApiEnv;

export function buildFulfillmentApi(services: FulfillmentServices) {
  const app = new Hono<FulfillmentApiEnv>();

  app.route("/account", createAccountShipmentRoutes(services.shipments));
  app.route("/account", createAccountSaleShipmentRoutes(services.shipments));

  return app;
}
