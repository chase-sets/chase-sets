import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { buildCustomerFeedbackAttentionApi } from "./features/attention/api/route";
import { buildCustomerFeedbackApi as buildCsatAdminApi } from "./features/csat/api/admin-http";
import type { CustomerFeedbackServices } from "./support/runtime-support/services";

export type CustomerFeedbackApiEnv = AuthenticatedApiEnv;

export function buildCustomerFeedbackApi(services: CustomerFeedbackServices) {
  const app = new Hono<CustomerFeedbackApiEnv>();
  app.route("/", buildCsatAdminApi(services.invitations));
  app.route("/", buildCustomerFeedbackAttentionApi(services.db));
  return app;
}
