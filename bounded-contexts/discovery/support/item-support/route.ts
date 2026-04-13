import { Hono } from "hono";
import type { DiscoveryItemsServices } from "./runtime";
import { discoveryItemDetailRoutes } from "../../features/item-detail/api/route";
import { discoveryItemSearchRoutes } from "../../features/search/api/route";

export function discoveryItemRoutes(services: DiscoveryItemsServices) {
  const app = new Hono();

  app.route("/", discoveryItemSearchRoutes(services.search));
  app.route("/", discoveryItemDetailRoutes(services.detail));

  return app;
}
