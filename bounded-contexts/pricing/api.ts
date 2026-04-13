import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PricingServices } from "./support/runtime-support/services";
import { createSellerRecommendationRoutes } from "./features/recommendations/api/route";

export type PricingApiEnv = AuthenticatedApiEnv;

export function buildPricingApi(services: PricingServices) {
  const app = new Hono<PricingApiEnv>();
  app.route("/seller", createSellerRecommendationRoutes(services.recommendations));
  return app;
}
