import { Hono } from "hono";
import type { CatalogServices } from "./infrastructure/wiring";
import { tenantContextMiddleware, type TenantContextEnv } from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { dimensionRoutes } from "./routes/dimensions";
import { fieldRoutes } from "./routes/fields";
import { componentRoutes } from "./routes/components";
import { blueprintRoutes } from "./routes/blueprints";
import { categoryRoutes } from "./routes/categories";
import { catalogItemRoutes } from "./routes/catalog-items";

export function buildCatalogApp(services: CatalogServices): Hono<TenantContextEnv> {
  const app = new Hono<TenantContextEnv>();

  app.onError(errorHandler);

  app.route("/health", healthRoutes());

  app.use("/api/*", tenantContextMiddleware);
  app.route("/api/dimensions", dimensionRoutes(services));
  app.route("/api/fields", fieldRoutes(services));
  app.route("/api/components", componentRoutes(services));
  app.route("/api/blueprints", blueprintRoutes(services));
  app.route("/api/categories", categoryRoutes(services));
  app.route("/api/catalog-items", catalogItemRoutes(services));

  return app;
}
