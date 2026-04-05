import { Hono } from "hono";
import { module as authModule } from "@chase-sets/auth";
import { module as identityModule } from "@chase-sets/identity";
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

export type IdentityApiHostServices = Readonly<{
  auth: ReturnType<typeof authModule.createServices>;
  identity: ReturnType<typeof identityModule.createServices>;
}>;

export function buildIdentityApp(services: IdentityApiHostServices) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = createContextApiMounts(services);
  const projectors = [...services.identity.projectors, ...services.auth.projectors];

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  attachApiMountMiddleware(
    app,
    apiMounts.map((mount) => mount.mountPath),
    createIdentityAuthMiddleware(services),
  );
  attachWriteDrainMiddleware(app, apiMounts, () => drainProjectors(projectors));
  mountApiRouters(app, apiMounts);

  return app;
}
