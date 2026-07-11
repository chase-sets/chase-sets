import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { CommercialTermsServices } from "./support/runtime-support/services";
import { createAgreementRoutes } from "./features/agreements/api/route";
import { createCheckoutProcessingFeeRoutes } from "./features/checkout-processing-fee/api/route";
import { createResolutionRoutes } from "./features/resolutions/api/route";
import { createScheduleRoutes } from "./features/schedules/api/route";

export type CommercialTermsApiEnv = AuthenticatedApiEnv;

export function buildCommercialTermsApi(services: CommercialTermsServices) {
  const app = new Hono<CommercialTermsApiEnv>();
  app.route("/schedules", createScheduleRoutes(services.schedules, services.resolutions));
  app.route("/agreements", createAgreementRoutes(services.agreements));
  app.route("/resolutions", createResolutionRoutes(services.resolutions));
  app.route("/checkout-processing-fee", createCheckoutProcessingFeeRoutes(services.policies));
  return app;
}
