import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PricingServices } from "./support/runtime-support/services";
import { createAccountRecommendationRoutes } from "./features/recommendations/api/route";
import { createMarketRollupsRoutes } from "./features/market-rollups/api/route";
import { createPublicMarketPageRoutes } from "./features/public-market-pages/api/route";
import { createBulkRepriceIngestionRoutes } from "./features/bulk-reprice-ingestion/api/route";
import { createEconomicsRoutes } from "./features/economics/api/route";
import { createRepricingDryRunRoutes } from "./features/repricing-engine/api/dry-run-route";
import { createRepricingPolicyRoutes } from "./features/repricing-policies/api/route";
import {
  createRepricingActivityRoutes,
  createRepricingActivityServices,
} from "./features/repricing-engine/api/activity-route";

export type PricingApiEnv = AuthenticatedApiEnv;

export function buildPricingApi(services: PricingServices) {
  const app = new Hono<PricingApiEnv>();
  app.route("/account/repricing-policies/dry-runs", createRepricingDryRunRoutes(services.repricingEngine));
  app.route("/account/repricing-policies", createRepricingActivityRoutes(createRepricingActivityServices(services.db)));
  app.route("/account/repricing-policies", createRepricingPolicyRoutes(services.repricingPolicies));
  app.route("/account", createAccountRecommendationRoutes(services.recommendations));
  app.route("/account/economics", createEconomicsRoutes(services.economics, services.economics.overrides));
  app.route("/market-rollups", createMarketRollupsRoutes(services.marketRollups));
  app.route("/public/market-pages", createPublicMarketPageRoutes(services.publicMarketPages));
  // One mount line: bulk reprice ingestion (m113) is a removable feature -- see
  // docs/bulk-reprice-ingestion.md for the full deletion checklist.
  app.route("/account/bulk-reprice", createBulkRepriceIngestionRoutes(services.bulkRepriceIngestion));
  return app;
}
