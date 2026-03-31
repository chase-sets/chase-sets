import { Hono } from "hono";
import {
  buildDiscoveryApi,
  type DiscoveryServices,
} from "@chase-sets/discovery";
import {
  buildMarketplaceApi,
  type MarketplaceServices,
} from "@chase-sets/marketplace-context";
import { createHealthRoutes } from "@chase-sets/http/health";
import {
  createMarketplaceAuthMiddleware,
  type MarketplaceActorResolver,
  type TenantContextEnv,
} from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";

export type BuildMarketplaceAppOptions = Readonly<{
  resolveActor?: MarketplaceActorResolver;
}>;

export function buildMarketplaceApp(
  services: Readonly<{
    discovery: DiscoveryServices;
    marketplace: MarketplaceServices;
  }>,
  options: BuildMarketplaceAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  app.use(
    "/api/marketplace/*",
    createMarketplaceAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  app.route("/api/marketplace", buildDiscoveryApi(services.discovery));
  app.route("/api/marketplace", buildMarketplaceApi(services.marketplace));

  return app;
}
