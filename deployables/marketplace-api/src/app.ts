import { Hono } from "hono";
import {
  buildDiscoveryApi,
  contextManifest as discoveryManifest,
  type DiscoveryServices,
} from "@chase-sets/discovery";
import {
  buildFulfillmentApi,
  contextManifest as fulfillmentManifest,
  type FulfillmentServices,
} from "@chase-sets/fulfillment";
import {
  buildMarketplaceApi,
  contextManifest as marketplaceManifest,
  type MarketplaceServices,
} from "@chase-sets/marketplace";
import type { InventoryServices } from "@chase-sets/inventory";
import {
  buildOrderingApi,
  contextManifest as orderingManifest,
  type OrderingServices,
} from "@chase-sets/ordering";
import {
  buildPaymentsApi,
  contextManifest as paymentsManifest,
  createStripeWebhookRoutes,
  type PaymentsServices,
} from "@chase-sets/payments";
import {
  buildReputationApi,
  contextManifest as reputationManifest,
  type ReputationServices,
} from "@chase-sets/reputation";
import {
  buildSettlementApi,
  contextManifest as settlementManifest,
  type SettlementServices,
} from "@chase-sets/settlement";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  collectProjectors,
  createResolvedApiMount,
  drainProjectors,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHealthRoutes } from "@chase-sets/http-host/health";
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
  const apiMounts = [
    createResolvedApiMount(
      discoveryManifest.contextName,
      discoveryManifest.apiMounts[0],
      buildDiscoveryApi(services.discovery),
    ),
    createResolvedApiMount(
      marketplaceManifest.contextName,
      marketplaceManifest.apiMounts[0],
      buildMarketplaceApi(services.marketplace),
    ),
    createResolvedApiMount(
      orderingManifest.contextName,
      orderingManifest.apiMounts[0],
      buildOrderingApi(services.ordering),
    ),
    createResolvedApiMount(
      fulfillmentManifest.contextName,
      fulfillmentManifest.apiMounts[0],
      buildFulfillmentApi(services.fulfillment),
    ),
    createResolvedApiMount(
      paymentsManifest.contextName,
      paymentsManifest.apiMounts[0],
      buildPaymentsApi(services.payments.payments),
    ),
    createResolvedApiMount(
      reputationManifest.contextName,
      reputationManifest.apiMounts[0],
      buildReputationApi(services.reputation),
    ),
    createResolvedApiMount(
      settlementManifest.contextName,
      settlementManifest.apiMounts[0],
      buildSettlementApi(services.settlement),
    ),
    createResolvedApiMount(
      paymentsManifest.contextName,
      paymentsManifest.apiMounts[1],
      createStripeWebhookRoutes(services.payments.payments),
    ),
  ] as const;

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

