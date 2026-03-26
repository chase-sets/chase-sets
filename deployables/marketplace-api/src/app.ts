import { Hono } from "hono";
import { buildDiscoveryApi, type DiscoveryServices } from "@chase-sets/discovery";
import { createHealthRoutes } from "@chase-sets/http/health";
import { errorHandler } from "./middleware/error-handler";

export function buildMarketplaceApp(services: DiscoveryServices): Hono {
  const app = new Hono();

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  app.route("/api/marketplace", buildDiscoveryApi(services));

  return app;
}
