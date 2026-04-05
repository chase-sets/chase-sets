import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PricingServices } from "./services";
import { createSellerRecommendationRoutes } from "./recommendations/route";

export type PricingApiEnv = AuthenticatedApiEnv;

export function buildPricingApi(services: PricingServices) {
  const app = new Hono<PricingApiEnv>();
  app.route("/seller", createSellerRecommendationRoutes(services.recommendations));
  return app;
}
