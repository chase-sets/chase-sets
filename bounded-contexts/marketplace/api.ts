import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createCommercialTermsResolver,
  type CommercialTermsResolver,
} from "@chase-sets/commercial-terms/server";
import type { MarketplaceServices } from "./support/runtime-support/services";
import {
  createPublicListingRoutes,
  createSellerRoutes as createSellerListingRoutes,
} from "./features/listings/api/route";
import {
  createBuyerOfferMatchRoutes,
  createSubmittedBuyerOfferRoutes,
} from "./features/offers/api/route";

export type MarketplaceApiEnv = AuthenticatedApiEnv;

export type { CommercialTermsResolver };

export function createMarketplaceCommercialTermsResolver(
  db: PgQueryable,
): CommercialTermsResolver {
  return createCommercialTermsResolver({ db });
}

export function buildMarketplaceApi(services: MarketplaceServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.route("/buyer", createSubmittedBuyerOfferRoutes(services.offers));
  app.route("/seller", createSellerListingRoutes(services.listings));
  app.route("/seller", createBuyerOfferMatchRoutes(services.offers));
  app.route("/", createPublicListingRoutes(services.listings));

  return app;
}
