import { Hono } from "hono";
import { module as inventoryModule } from "@chase-sets/inventory";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
import { createContextApiMounts } from "./context-api-mounts.generated";
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
  services: ReturnType<typeof inventoryModule.createServices>,
  options: BuildInventoryAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = createContextApiMounts(services);

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  attachApiMountMiddleware(
    app,
    apiMounts.map((mount) => mount.mountPath),
    createInventoryAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  attachWriteDrainMiddleware(app, apiMounts, () => drainProjectors(services.projectors));
  mountApiRouters(app, apiMounts);

  return app;
}
