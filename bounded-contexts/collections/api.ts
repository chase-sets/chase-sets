import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createSavedListValuationRoutes } from "./features/saved-list-valuation/api/route";
import { savedListQueryRoutes } from "./features/saved-lists/api/query-route";
import type { CollectionsServices } from "./support/runtime-support/services";
import { createGuestSavedListRoutes, createSavedListRoutes } from "./features/saved-lists/api/route";

export type CollectionsActor = Readonly<{
  accountId: string;
  permissions: readonly string[];
}>;

export type CollectionsApiEnv = {
  Variables: {
    actor: CollectionsActor;
    context: EventStoreContext;
  };
};

export function buildCollectionsApi(services: CollectionsServices) {
  const app = new Hono<CollectionsApiEnv>();

  app.route("/guest", createGuestSavedListRoutes(services.discovery, services.rateLimitPolicyResolver));

  app.use("*", async (c, next) => {
    if (!c.get("actor")) {
      return c.json({ error: { code: "authentication_required" } }, 401);
    }
    await next();
  });

  app.route("/saved-lists", savedListQueryRoutes(services.savedListReadModels));
  app.route("/", createSavedListValuationRoutes(services.savedListValuation));
  app.route("/", createSavedListRoutes(services.discovery));
  return app;
}
