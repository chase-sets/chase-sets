import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/identity/server";
import type { MarketplaceServices } from "./services";
import { createPublicListingRoutes, createSellerRoutes } from "./listings/route";

export type MarketplaceApiEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
  };
};

async function drainProjectors(services: MarketplaceServices) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function buildMarketplaceApi(services: MarketplaceServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.use("*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors(services);
    }
  });

  app.route("/seller", createSellerRoutes(services.listings));
  app.route("/", createPublicListingRoutes(services.listings));

  return app;
}
