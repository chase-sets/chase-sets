import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createCommercialTermsResolver,
  quoteLockedMarketplaceFeeTerms,
  type CommercialTermsResolver,
} from "@chase-sets/commercial-terms/server";
import type { MarketplaceServices } from "./support/runtime-support/services";
import { createPublicListingRoutes, createAccountListingRoutes } from "./features/listings/api/route";
import { createListingGatePolicyRoutes } from "./features/listings/api/listing-gate-policy-route";
import { createAccountOfferMatchRoutes, createAccountSubmittedOfferRoutes } from "./features/offers/api/route";
import { createMarketplaceReportRoutes } from "./features/reports/api/route";
import { createListingEvidencePolicyRoutes } from "./features/listing-evidence-policy/api/route";

export type MarketplaceApiEnv = AuthenticatedApiEnv;

export type { CommercialTermsResolver };
export { quoteLockedMarketplaceFeeTerms };

export function createMarketplaceCommercialTermsResolver(db: PgQueryable): CommercialTermsResolver {
  return createCommercialTermsResolver({ db });
}

export function buildMarketplaceApi(services: MarketplaceServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.route("/account", createAccountSubmittedOfferRoutes(services.offers));
  app.route("/account", createAccountListingRoutes(services.listings));
  app.route("/account", createAccountOfferMatchRoutes(services.offers));
  app.route("/", createPublicListingRoutes(services.listings, services.rateLimitPolicyResolver));
  app.route("/", createMarketplaceReportRoutes(services.reports));
  app.route("/listing-gate-policy", createListingGatePolicyRoutes(services.policies));
  app.route("/listing-evidence-policy", createListingEvidencePolicyRoutes(services.listingEvidencePolicies));

  return app;
}
