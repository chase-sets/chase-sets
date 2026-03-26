import { Hono } from "hono";
import type { DiscoveryItemsServices } from "./runtime";
import { discoveryItemDetailRoutes } from "./detail/route";
import { discoveryItemSearchRoutes } from "./search/route";

export function discoveryItemRoutes(services: DiscoveryItemsServices): Hono {
  const app = new Hono();

  app.route("/", discoveryItemSearchRoutes(services.search));
  app.route("/", discoveryItemDetailRoutes(services.detail));

  return app;
}