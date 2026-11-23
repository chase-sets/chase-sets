import { Hono } from "hono";
import { createSavedListValuationRoutes } from "./features/saved-list-valuation/api/route";
import { savedListQueryRoutes } from "./features/saved-lists/api/query-route";
import { requireCollectionsActor, type CollectionsApiEnv } from "./support/runtime-support/api-auth";
import type { CollectionsServices } from "./support/runtime-support/services";
import { createGuestSavedListRoutes, createSavedListRoutes } from "./features/saved-lists/api/route";

export type { CollectionsActor, CollectionsApiEnv } from "./support/runtime-support/api-auth";

export function buildCollectionsApi(services: CollectionsServices) {
  const app = new Hono<CollectionsApiEnv>();

  app.route("/guest", createGuestSavedListRoutes(services.discovery, services.rateLimitPolicyResolver));

  app.use("*", requireCollectionsActor);

  app.route("/saved-lists", savedListQueryRoutes(services.savedListReadModels));
  app.route("/", createSavedListValuationRoutes(services.savedListValuation, services.savedListAnalyticsRecorder));
  app.route("/", createSavedListRoutes(services.discovery, services.savedListAnalyticsRecorder, services.recovery));
  return app;
}
