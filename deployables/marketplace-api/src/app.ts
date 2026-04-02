import { Hono } from "hono";
import {
  buildDiscoveryApi,
  type DiscoveryServices,
} from "@chase-sets/discovery";
import {
  buildMarketplaceApi,
  type MarketplaceServices,
} from "@chase-sets/marketplace-context";
import type { InventoryServices } from "@chase-sets/inventory";
import {
  buildOrderingApi,
  type OrderingServices,
} from "@chase-sets/ordering";
import {
  buildPaymentsApi,
  createStripeWebhookRoutes,
  type PaymentsServices,
} from "@chase-sets/payments";
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
    inventory: InventoryServices;
    marketplace: MarketplaceServices;
    ordering: OrderingServices;
    payments: PaymentsServices;
  }>,
  options: BuildMarketplaceAppOptions = {},
) {
  const app = new Hono<TenantContextEnv>();

  async function drainProjectors() {
    let processed = 0;

    do {
      processed = 0;

      for (const projector of [
        ...services.inventory.projectors,
        ...services.marketplace.projectors,
        ...services.payments.projectors,
        ...services.ordering.projectors,
      ]) {
        const result = await projector.runOnce();
        processed += result.processed;
      }
    } while (processed > 0);
  }

  app.onError(errorHandler);
  app.route("/health", createHealthRoutes());
  app.use(
    "/api/marketplace/*",
    createMarketplaceAuthMiddleware(options.resolveActor ?? (async () => null)),
  );
  app.use("/api/marketplace/*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors();
    }
  });
  app.use("/api/payments/*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors();
    }
  });
  app.route("/api/marketplace", buildDiscoveryApi(services.discovery));
  app.route("/api/marketplace", buildMarketplaceApi(services.marketplace));
  app.route("/api/marketplace", buildOrderingApi(services.ordering));
  app.route("/api/marketplace", buildPaymentsApi(services.payments.payments));
  app.route("/api/payments/stripe", createStripeWebhookRoutes(services.payments.payments));

  return app;
}
