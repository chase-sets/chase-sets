import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { CommercialTermsServices } from "./support/runtime-support/services";
import { createAgreementRoutes } from "./features/agreements/api/route";
import { createAuthenticityFeeRoutes } from "./features/authenticity-fee/api/route";
import { createCheckoutProcessingFeeRoutes } from "./features/checkout-processing-fee/api/route";
import { createResolutionRoutes } from "./features/resolutions/api/route";
import { createScheduleRoutes } from "./features/schedules/api/route";
import { createPublicMarketplaceSalesFeeScheduleRoutes } from "./features/marketplace-sales-fee/api/route";

export type CommercialTermsApiEnv = AuthenticatedApiEnv;

export function buildCommercialTermsApi(services: CommercialTermsServices) {
  const app = new Hono<CommercialTermsApiEnv>();
  app.route("/schedules", createScheduleRoutes(services.schedules, services.resolutions));
  app.route("/agreements", createAgreementRoutes(services.agreements));
  app.route("/resolutions", createResolutionRoutes(services.resolutions));
  app.route("/checkout-processing-fee", createCheckoutProcessingFeeRoutes(services.policies));
  app.route("/authenticity-fee", createAuthenticityFeeRoutes(services.policies));
  return app;
}

export function buildCommercialTermsPublicApi(services: CommercialTermsServices) {
  const app = new Hono<CommercialTermsApiEnv>();
  app.route("/", createPublicMarketplaceSalesFeeScheduleRoutes(services.policies));
  return app;
}
