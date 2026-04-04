import { Hono } from "hono";
import {
  buildInventoryApi,
  contextManifest as inventoryManifest,
  type InventoryServices,
} from "@chase-sets/inventory";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  createResolvedApiMount,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
import {
  createInventoryAuthMiddleware,
  type InventoryActorResolver,
  type TenantContextEnv,
} from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";

export type BuildInventoryAppOptions = Readonly<{
  resolveActor?: InventoryActorResolver;
}>;

export function buildInventoryApp(
  services: InventoryServices,
  options: BuildInventoryAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();
  const apiMount = createResolvedApiMount(
    inventoryManifest.contextName,
    inventoryManifest.apiMounts[0],
    buildInventoryApi(services),
  );

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  attachApiMountMiddleware(
    app,
    [apiMount.mountPath],
    createInventoryAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  attachWriteDrainMiddleware(app, [apiMount], () => drainProjectors(services.projectors));
  mountApiRouters(app, [apiMount]);

  return app;
}
