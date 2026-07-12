import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { createOpsDashboardRoutes } from "./features/insights-dashboards/api/ops-http";
import { createPolicyConsoleRoutes } from "./features/policy-console/api/policy-console-route";
import { createRateLimitPolicyRoutes } from "./features/rate-limit-policy/api/rate-limit-policy-route";
import { createSupportDeadlinePolicyRoutes } from "./features/support-requests/api/deadline-policy-route";
import { createSupportReferenceLookupRoutes } from "./features/support-reference-lookup/api/route";
import type { PlatformOperationsServices } from "./support/runtime-support/services";

export type PlatformOperationsApiEnv = AuthenticatedApiEnv;

export function buildPlatformOperationsApi(services: PlatformOperationsServices) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.route("/rate-limit-policy", createRateLimitPolicyRoutes(services.policies));
  app.route("/support-deadline-policy", createSupportDeadlinePolicyRoutes(services.policies));
  app.route("/policy-console", createPolicyConsoleRoutes(services.policyConsoleEntries));
  app.route("/support-reference-lookup", createSupportReferenceLookupRoutes(services.supportReferenceLookup));
  app.route("/insights/ops", createOpsDashboardRoutes(services.opsDashboard));

  return app;
}
