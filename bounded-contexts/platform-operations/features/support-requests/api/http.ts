import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { createAccountSupportRequestRoutes } from "./route";
import type { SupportRequestServices } from "./runtime";

export type SupportApiEnv = AuthenticatedApiEnv;

export function buildSupportApi(supportRequests: SupportRequestServices) {
  const app = new Hono<SupportApiEnv>();

  app.route("/support-requests", createAccountSupportRequestRoutes(supportRequests));

  return app;
}
