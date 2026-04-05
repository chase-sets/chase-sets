import { Hono } from "hono";
import { module as catalogModule } from "@chase-sets/catalog";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
import { createContextApiMounts } from "./context-api-mounts.generated";
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
  services: ReturnType<typeof catalogModule.createServices>,
  options: BuildCatalogAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = createContextApiMounts(services);

  app.onError(errorHandler);

  app.route("/health", createHealthRoutes());

  attachApiMountMiddleware(
    app,
    apiMounts.map((mount) => mount.mountPath),
    createCatalogAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  attachWriteDrainMiddleware(app, apiMounts, () => drainProjectors(services.projectors));
  mountApiRouters(app, apiMounts);

  return app;
}

