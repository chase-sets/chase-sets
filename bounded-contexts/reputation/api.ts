import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { ReputationServices } from "./services";
import {
  createAccountReviewRoutes,
  createPublicReputationRoutes,
} from "./reviews/route";

export type ReputationApiEnv = AuthenticatedApiEnv;

async function drainProjectors(services: ReputationServices) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function buildReputationApi(services: ReputationServices) {
  const app = new Hono<ReputationApiEnv>();

  app.use("*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors(services);
    }
  });

  app.route("/reviews", createAccountReviewRoutes(services.reviews));
  app.route("/accounts", createPublicReputationRoutes(services.reviews));

  return app;
}
