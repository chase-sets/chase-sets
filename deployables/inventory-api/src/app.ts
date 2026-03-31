import { Hono } from "hono";
import { buildInventoryApi, type InventoryServices } from "@chase-sets/inventory";
import { createHealthRoutes } from "@chase-sets/http/health";
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

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  app.use(
    "/api/inventory/*",
    createInventoryAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  app.route("/api/inventory", buildInventoryApi(services));

  return app;
}
