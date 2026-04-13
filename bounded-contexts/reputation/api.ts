import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { ReputationServices } from "./support/runtime-support/services";
import {
  createAccountReviewRoutes,
  createPublicReputationRoutes,
} from "./features/reviews/api/route";

export type ReputationApiEnv = AuthenticatedApiEnv;

export function buildReputationApi(services: ReputationServices) {
  const app = new Hono<ReputationApiEnv>();

  app.route("/reviews", createAccountReviewRoutes(services.reviews));
  app.route("/accounts", createPublicReputationRoutes(services.reviews));

  return app;
}
