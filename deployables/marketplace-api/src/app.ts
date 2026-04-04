import { Hono } from "hono";
import { type DiscoveryServices } from "@chase-sets/discovery";
import { type FulfillmentServices } from "@chase-sets/fulfillment";
import { type MarketplaceServices } from "@chase-sets/marketplace";
import type { InventoryServices } from "@chase-sets/inventory";
import { type OrderingServices } from "@chase-sets/ordering";
import { type PaymentsServices } from "@chase-sets/payments";
import { type ReputationServices } from "@chase-sets/reputation";
import { type SettlementServices } from "@chase-sets/settlement";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  collectProjectors,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
import { createContextApiMounts } from "./context-api-mounts.generated";
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
    fulfillment: FulfillmentServices;
    inventory: InventoryServices;
    marketplace: MarketplaceServices;
    ordering: OrderingServices;
    payments: PaymentsServices;
    reputation: ReputationServices;
    settlement: SettlementServices;
  }>,
  options: BuildMarketplaceAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();
  const projectors = collectProjectors([
    services.discovery,
    services.inventory,
    services.marketplace,
    services.payments,
    services.fulfillment,
    services.ordering,
    services.reputation,
    services.settlement,
  ]);
  const apiMounts = createContextApiMounts(services);

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  attachApiMountMiddleware(
    app,
    apiMounts.filter((mount) => mount.requiresAuth).map((mount) => mount.mountPath),
    createMarketplaceAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  attachWriteDrainMiddleware(app, apiMounts, () => drainProjectors(projectors));
  mountApiRouters(app, apiMounts);

  return app;
}

