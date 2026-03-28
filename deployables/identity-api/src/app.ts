import { Hono } from "hono";
import { buildIdentityApi, type IdentityServices } from "@chase-sets/identity";
import { createHealthRoutes } from "@chase-sets/http/health";
import { errorHandler } from "./middleware/error-handler";
import {
  tenantContextMiddleware,
  type TenantContextEnv,
} from "./middleware/tenant-context";

export function buildIdentityApp(services: IdentityServices) {
  const app = new Hono<TenantContextEnv>();

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  app.use("/api/identity/*", tenantContextMiddleware);
  app.route("/api/identity", buildIdentityApi(services));

  return app;
}
