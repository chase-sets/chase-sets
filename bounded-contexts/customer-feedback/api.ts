import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { buildCustomerFeedbackAttentionApi } from "./features/attention/api/route";
import { buildCustomerFeedbackApi as buildCsatAdminApi } from "./features/csat/api/admin-http";
import type { CustomerFeedbackServices } from "./support/runtime-support/services";
import { buildCustomerFeedbackPrivacyApi } from "./features/privacy/api/route";

export type CustomerFeedbackApiEnv = AuthenticatedApiEnv;

export function buildCustomerFeedbackApi(services: CustomerFeedbackServices) {
  const app = new Hono<CustomerFeedbackApiEnv>();
  app.route("/", buildCsatAdminApi(services.invitations));
  app.route("/", buildCustomerFeedbackAttentionApi(services));
  app.route("/", buildCustomerFeedbackPrivacyApi(services.privacy));
  return app;
}
