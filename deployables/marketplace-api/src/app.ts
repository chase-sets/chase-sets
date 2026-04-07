import { Hono } from "hono";
import { module as discoveryModule } from "@chase-sets/discovery";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as pricingModule } from "@chase-sets/pricing";
import { module as reputationModule } from "@chase-sets/reputation";
import { module as settlementModule } from "@chase-sets/settlement";
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
  createMarketplaceAuthMiddleware,
  type MarketplaceActorResolver,
  type TenantContextEnv,
} from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";

export type BuildMarketplaceAppOptions = Readonly<{
  drain?: () => Promise<void>;
  getProjectionReplay?: () =>
    | HealthProjectionReplaySummary
    | Promise<HealthProjectionReplaySummary>;
  resolveActor?: MarketplaceActorResolver;
}>;

export function buildMarketplaceApp(
  services: Readonly<{
    discovery: ReturnType<typeof discoveryModule.createServices>;
    fulfillment: ReturnType<typeof fulfillmentModule.createServices>;
    inventory: ReturnType<typeof inventoryModule.createServices>;
    marketplace: ReturnType<typeof marketplaceModule.createServices>;
    ordering: ReturnType<typeof orderingModule.createServices>;
    payments: ReturnType<typeof paymentsModule.createServices>;
    pricing: ReturnType<typeof pricingModule.createServices>;
    reputation: ReturnType<typeof reputationModule.createServices>;
    settlement: ReturnType<typeof settlementModule.createServices>;
  }>,
  options: BuildMarketplaceAppOptions = {},
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
    apiMounts.filter((mount) => mount.requiresAuth).map((mount) => mount.mountPath),
    createMarketplaceAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  attachWriteDrainMiddleware(
    app,
    apiMounts,
    options.drain ?? (() => Promise.resolve()),
  );
  mountApiRouters(app, apiMounts);

  return app;
}

