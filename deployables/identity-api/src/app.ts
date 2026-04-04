import { Hono } from "hono";
import { type IdentityServices } from "@chase-sets/identity";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
import { createContextApiMounts } from "./context-api-mounts.generated";
import { errorHandler } from "./middleware/error-handler";
import {
  createIdentityAuthMiddleware,
  type TenantContextEnv,
} from "./middleware/tenant-context";

export function buildIdentityApp(services: IdentityServices) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = createContextApiMounts(services);

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  attachApiMountMiddleware(
    app,
    apiMounts.map((mount) => mount.mountPath),
    createIdentityAuthMiddleware(services),
  );
  attachWriteDrainMiddleware(app, apiMounts, () => drainProjectors(services.projectors));
  mountApiRouters(app, apiMounts);

  return app;
}
