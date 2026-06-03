import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { DiscoveryServices } from "./support/runtime-support/services";
import { discoveryCategoryRoutes } from "./features/categories/api/route";
import { discoveryItemRoutes } from "./support/item-support/route";
import { discoveryMarketRoutes } from "./support/market-support/route";
import { createGoogleShoppingSyncRoutes } from "./support/google-shopping-support/route";
import { createProductAlertRoutes } from "./features/product-alerts/api/route";

export type DiscoveryApiEnv = AuthenticatedApiEnv;

export function buildDiscoveryApi(services: DiscoveryServices) {
  const app = new Hono<DiscoveryApiEnv>();

  app.route("/account", createProductAlertRoutes(services.productAlerts));
  app.route("/items", discoveryItemRoutes(services.items));
  app.route("/categories", discoveryCategoryRoutes(services.categories));
  app.route("/google-shopping", createGoogleShoppingSyncRoutes(services.googleShoppingSync));
  app.route("/", discoveryMarketRoutes(services.items.market));

  return app;
}
