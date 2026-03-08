import { Hono } from "hono";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import {
  discoveryCategoryRoutes,
  discoveryItemRoutes,
  type DiscoveryServices,
} from "../../../bounded-contexts/discovery/api";

export function buildMarketplaceApp(services: DiscoveryServices): Hono {
  const app = new Hono();

  app.onError(errorHandler);
  app.route("/health", healthRoutes());
  app.route("/api/marketplace/items", discoveryItemRoutes(services));
  app.route("/api/marketplace/categories", discoveryCategoryRoutes(services));

  return app;
}
