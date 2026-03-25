import { Hono } from "hono";
import { buildDiscoveryApi, type DiscoveryServices } from "../../../bounded-contexts/discovery";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";

export function buildMarketplaceApp(services: DiscoveryServices): Hono {
  const app = new Hono();

  app.onError(errorHandler);
  app.route("/health", healthRoutes());
  app.route("/api/marketplace", buildDiscoveryApi(services));

  return app;
}