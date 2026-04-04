import { Hono } from "hono";
import {
  buildCatalogAuthoringApi,
  contextManifest as catalogManifest,
  type CatalogServices,
} from "@chase-sets/catalog";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  createResolvedApiMount,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
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
  const apiMount = createResolvedApiMount(
    catalogManifest.contextName,
    catalogManifest.apiMounts[0],
    buildCatalogAuthoringApi(services),
  );

  app.onError(errorHandler);

  app.route("/health", createHealthRoutes());

  attachApiMountMiddleware(
    app,
    [apiMount.mountPath],
    createCatalogAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  attachWriteDrainMiddleware(app, [apiMount], () => drainProjectors(services.projectors));
  mountApiRouters(app, [apiMount]);

  return app;
}

