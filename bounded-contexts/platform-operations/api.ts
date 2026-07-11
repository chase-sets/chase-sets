import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { createRateLimitPolicyRoutes } from "./features/rate-limit-policy/api/rate-limit-policy-route";
import { createSupportDeadlinePolicyRoutes } from "./features/support-requests/api/deadline-policy-route";
import type { PlatformOperationsServices } from "./support/runtime-support/services";

export type PlatformOperationsApiEnv = AuthenticatedApiEnv;

export function buildPlatformOperationsApi(services: PlatformOperationsServices) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.route("/rate-limit-policy", createRateLimitPolicyRoutes(services.policies));
  app.route("/support-deadline-policy", createSupportDeadlinePolicyRoutes(services.policies));

  return app;
}
