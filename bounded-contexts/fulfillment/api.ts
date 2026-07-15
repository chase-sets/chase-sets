import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { FulfillmentServices } from "./support/runtime-support/services";
import {
  createAccountShipmentRoutes,
  createAccountSaleShipmentRoutes,
  createPostageProviderWebhookRoutes,
} from "./features/shipments/api/route";
import { createReturnIntakeRoutes } from "./features/return-shipments/api/route";

export type FulfillmentApiEnv = AuthenticatedApiEnv;

export function buildFulfillmentApi(services: FulfillmentServices) {
  const app = new Hono<FulfillmentApiEnv>();

  app.route("/account", createAccountShipmentRoutes(services.shipments));
  app.route("/account", createAccountSaleShipmentRoutes(services.shipments));
  app.route("/operations/return-intake", createReturnIntakeRoutes(services.returnShipments));

  return app;
}

export function buildFulfillmentProviderWebhookApi(services: FulfillmentServices) {
  const app = new Hono();

  app.route("/", createPostageProviderWebhookRoutes(services.shipments));

  return app;
}
