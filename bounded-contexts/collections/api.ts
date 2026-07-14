import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { createSavedListValuationRoutes } from "./features/saved-list-valuation/api/route";
import type { CollectionsServices } from "./support/runtime-support/services";

export type CollectionsApiEnv = AuthenticatedApiEnv;

export function buildCollectionsApi(services: CollectionsServices) {
  const app = new Hono<CollectionsApiEnv>();
  app.route("/", createSavedListValuationRoutes(services.savedListValuation));
  return app;
}
