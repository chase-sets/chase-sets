import { Hono } from "hono";
import type { DiscoveryServices } from "./support/runtime-support/services";
import { discoveryCategoryRoutes } from "./features/categories/api/route";
import { discoveryItemRoutes } from "./support/item-support/route";
import { discoveryMarketRoutes } from "./support/market-support/route";

export function buildDiscoveryApi(services: DiscoveryServices) {
  const app = new Hono();

  app.route("/items", discoveryItemRoutes(services.items));
  app.route("/categories", discoveryCategoryRoutes(services.categories));
  app.route("/", discoveryMarketRoutes(services.items.market));

  return app;
}
