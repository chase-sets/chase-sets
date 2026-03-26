import { Hono } from "hono";
import type { DiscoveryServices } from "./services";
import { discoveryCategoryRoutes } from "./categories/route";
import { discoveryItemRoutes } from "./items/route";

export function buildDiscoveryApi(services: DiscoveryServices) {
  const app = new Hono();

  app.route("/items", discoveryItemRoutes(services.items));
  app.route("/categories", discoveryCategoryRoutes(services.categories));

  return app;
}

