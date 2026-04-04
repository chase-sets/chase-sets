import { Hono } from "hono";
import {
  buildIdentityApi,
  contextManifest as identityManifest,
  type IdentityServices,
} from "@chase-sets/identity";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  createResolvedApiMount,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
import { errorHandler } from "./middleware/error-handler";
import {
  createIdentityAuthMiddleware,
  type TenantContextEnv,
} from "./middleware/tenant-context";

export function buildIdentityApp(services: IdentityServices) {
  const app = new Hono<TenantContextEnv>();
  const apiMount = createResolvedApiMount(
    identityManifest.contextName,
    identityManifest.apiMounts[0],
    buildIdentityApi(services),
  );

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  attachApiMountMiddleware(app, [apiMount.mountPath], createIdentityAuthMiddleware(services));
  attachWriteDrainMiddleware(app, [apiMount], () => drainProjectors(services.projectors));
  mountApiRouters(app, [apiMount]);

  return app;
}
