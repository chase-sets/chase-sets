import { Hono } from "hono";
import { buildCatalogAuthoringApi, type CatalogServices } from "../../../bounded-contexts/catalog/authoring/api";
import { tenantContextMiddleware, type TenantContextEnv } from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";

export function buildCatalogApp(services: CatalogServices): Hono<TenantContextEnv> {
  const app = new Hono<TenantContextEnv>();

  app.onError(errorHandler);

  app.route("/health", healthRoutes());

  app.use("/api/catalog/*", tenantContextMiddleware);
  app.route("/api/catalog", buildCatalogAuthoringApi(services));

  return app;
}
