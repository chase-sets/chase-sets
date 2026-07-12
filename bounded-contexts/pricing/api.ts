import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PricingServices } from "./support/runtime-support/services";
import { createAccountRecommendationRoutes } from "./features/recommendations/api/route";
import { createMarketRollupsRoutes } from "./features/market-rollups/api/route";
import { createPublicMarketPageRoutes } from "./features/public-market-pages/api/route";
import { createBulkRepriceIngestionRoutes } from "./features/bulk-reprice-ingestion/api/route";

export type PricingApiEnv = AuthenticatedApiEnv;

export function buildPricingApi(services: PricingServices) {
  const app = new Hono<PricingApiEnv>();
  app.route("/account", createAccountRecommendationRoutes(services.recommendations));
  app.route("/market-rollups", createMarketRollupsRoutes(services.marketRollups));
  app.route("/public/market-pages", createPublicMarketPageRoutes(services.publicMarketPages));
  // One mount line: bulk reprice ingestion (m113) is a removable feature -- see
  // docs/bulk-reprice-ingestion.md for the full deletion checklist.
  app.route("/account/bulk-reprice", createBulkRepriceIngestionRoutes(services.bulkRepriceIngestion));
  return app;
}
