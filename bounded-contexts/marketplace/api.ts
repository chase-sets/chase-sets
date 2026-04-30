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
  createAccountListingRoutes,
} from "./features/listings/api/route";
import {
  createAccountOfferMatchRoutes,
  createAccountSubmittedOfferRoutes,
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

  app.route("/account", createAccountSubmittedOfferRoutes(services.offers));
  app.route("/account", createAccountListingRoutes(services.listings));
  app.route("/account", createAccountOfferMatchRoutes(services.offers));
  app.route("/", createPublicListingRoutes(services.listings));

  return app;
}
