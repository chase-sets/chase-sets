import { Hono } from "hono";
import { module as catalogModule } from "@chase-sets/catalog";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import {
  createHealthRoutes,
  type HealthProjectionReplaySummary,
} from "@chase-sets/http-host/health";
import { createContextApiMounts } from "./context-api-mounts.generated";
import {
  createCatalogAuthMiddleware,
  type CatalogActorResolver,
  type TenantContextEnv,
} from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";

export type BuildCatalogAppOptions = Readonly<{
  drain?: () => Promise<void>;
  getProjectionReplay?: () =>
    | HealthProjectionReplaySummary
    | Promise<HealthProjectionReplaySummary>;
  resolveActor?: CatalogActorResolver;
}>;

export function buildCatalogApp(
  services: ReturnType<typeof catalogModule.createServices>,
  options: BuildCatalogAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = createContextApiMounts(services);

  app.onError(errorHandler);

  app.route(
    "/health",
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
    }),
  );

  attachApiMountMiddleware(
    app,
    apiMounts.map((mount) => mount.mountPath),
    createCatalogAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  attachWriteDrainMiddleware(
    app,
    apiMounts,
    options.drain ?? (() => Promise.resolve()),
  );
  mountApiRouters(app, apiMounts);

  return app;
}

