import { Hono } from "hono";
import { buildCatalogAuthoringApi, type CatalogServices } from "@chase-sets/catalog";
import { createHealthRoutes } from "@chase-sets/http/health";
import {
  createCatalogAuthMiddleware,
  type CatalogActorResolver,
  type TenantContextEnv,
} from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";

export type BuildCatalogAppOptions = Readonly<{
  resolveActor?: CatalogActorResolver;
}>;

export function buildCatalogApp(
  services: CatalogServices,
  options: BuildCatalogAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();

  app.onError(errorHandler);

  app.route("/health", createHealthRoutes());

  app.use(
    "/api/catalog/*",
    createCatalogAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  app.route("/api/catalog", buildCatalogAuthoringApi(services));

  return app;
}

