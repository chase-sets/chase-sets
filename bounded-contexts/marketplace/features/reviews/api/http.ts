import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { createAccountReviewRoutes, createPublicReputationRoutes } from "./route";
import type { createReviewRuntime } from "./runtime";

export type ReputationApiEnv = AuthenticatedApiEnv;

export function buildReviewApi(reviews: ReturnType<typeof createReviewRuntime>) {
  const app = new Hono<ReputationApiEnv>();

  app.route("/reviews", createAccountReviewRoutes(reviews));
  app.route("/accounts", createPublicReputationRoutes(reviews));

  return app;
}
