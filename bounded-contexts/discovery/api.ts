import { Hono } from "hono";
import type { DiscoveryServices } from "./services";
import { discoveryCategoryRoutes } from "./categories/route";
import { discoveryItemDetailRoutes } from "./item-detail/route";
import { discoverySearchRoutes } from "./search/route";

export function buildDiscoveryApi(services: DiscoveryServices): Hono {
  const app = new Hono();

  app.route("/items", discoverySearchRoutes(services));
  app.route("/items", discoveryItemDetailRoutes(services));
  app.route("/categories", discoveryCategoryRoutes(services));

  return app;
}