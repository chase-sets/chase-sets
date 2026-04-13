import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { MarketplaceServices } from "./support/runtime-support/services";
import {
  createPublicListingRoutes,
  createSellerRoutes as createSellerListingRoutes,
} from "./features/listings/api/route";
import {
  createBuyerOfferRoutes,
  createSellerOfferRoutes,
} from "./features/offers/api/route";

export type MarketplaceApiEnv = AuthenticatedApiEnv;

export function buildMarketplaceApi(services: MarketplaceServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.route("/buyer", createBuyerOfferRoutes(services.offers));
  app.route("/seller", createSellerListingRoutes(services.listings));
  app.route("/seller", createSellerOfferRoutes(services.offers));
  app.route("/", createPublicListingRoutes(services.listings));

  return app;
}
