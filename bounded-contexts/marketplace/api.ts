import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { MarketplaceServices } from "./services";
import {
  createPublicListingRoutes,
  createSellerRoutes as createSellerListingRoutes,
} from "./listings/route";
import {
  createBuyerOfferRoutes,
  createSellerOfferRoutes,
} from "./offers/route";

export type MarketplaceApiEnv = AuthenticatedApiEnv;

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

  app.route("/buyer", createBuyerOfferRoutes(services.offers));
  app.route("/seller", createSellerListingRoutes(services.listings));
  app.route("/seller", createSellerOfferRoutes(services.offers));
  app.route("/", createPublicListingRoutes(services.listings));

  return app;
}
