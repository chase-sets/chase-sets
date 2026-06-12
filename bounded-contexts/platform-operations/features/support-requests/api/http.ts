import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { createAccountSupportRequestRoutes } from "./route";
import type { createSupportRequestRuntime } from "./runtime";

export type SupportApiEnv = AuthenticatedApiEnv;

export function buildSupportApi(supportRequests: ReturnType<typeof createSupportRequestRuntime>) {
  const app = new Hono<SupportApiEnv>();

  app.route("/support-requests", createAccountSupportRequestRoutes(supportRequests));

  return app;
}
