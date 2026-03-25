import { Hono } from "hono";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { discoveryCategoryRoutes } from "../../../bounded-contexts/discovery/categories/route";
import { discoveryItemDetailRoutes } from "../../../bounded-contexts/discovery/item-detail/route";
import { discoverySearchRoutes } from "../../../bounded-contexts/discovery/search/route";
import type { DiscoveryServices } from "../../../bounded-contexts/discovery/services";

export function buildMarketplaceApp(services: DiscoveryServices): Hono {
  const app = new Hono();

  app.onError(errorHandler);
  app.route("/health", healthRoutes());
  app.route("/api/marketplace/items", discoverySearchRoutes(services));
  app.route("/api/marketplace/items", discoveryItemDetailRoutes(services));
  app.route("/api/marketplace/categories", discoveryCategoryRoutes(services));

  return app;
}
