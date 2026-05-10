import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { SupportServices } from "./support/runtime-support/services";
import { createAccountSupportRequestRoutes } from "./features/support-requests/api/route";

export type SupportApiEnv = AuthenticatedApiEnv;

export function buildSupportApi(services: SupportServices) {
  const app = new Hono<SupportApiEnv>();

  app.route("/support-requests", createAccountSupportRequestRoutes(services.supportRequests));

  return app;
}
