import { Hono } from "hono";
import { buildCatalogAuthoringApi, type CatalogServices } from "@chase-sets/catalog-authoring";
import { createHealthRoutes } from "@chase-sets/http/health";
import { tenantContextMiddleware, type TenantContextEnv } from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";

export function buildCatalogApp(services: CatalogServices) {
  const app = new Hono<TenantContextEnv>();

  app.onError(errorHandler);

  app.route("/health", createHealthRoutes());

  app.use("/api/catalog/*", tenantContextMiddleware);
  app.route("/api/catalog", buildCatalogAuthoringApi(services));

  return app;
}
