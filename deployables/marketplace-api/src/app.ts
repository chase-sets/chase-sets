import { Hono } from "hono";
import type { MarketplaceServices } from "./infrastructure/wiring";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { marketplaceItemRoutes } from "./routes/marketplace-items";
import { marketplaceCategoryRoutes } from "./routes/marketplace-categories";

export function buildMarketplaceApp(services: MarketplaceServices): Hono {
  const app = new Hono();

  app.onError(errorHandler);
  app.route("/health", healthRoutes());
  app.route("/api/marketplace/items", marketplaceItemRoutes(services));
  app.route("/api/marketplace/categories", marketplaceCategoryRoutes(services));

  return app;
}
