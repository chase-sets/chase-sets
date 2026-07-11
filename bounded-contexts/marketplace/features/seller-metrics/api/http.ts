import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { createAccountSellerMetricsRoutes, createPublicSellerMetricsRoutes } from "./route";
import type { createSellerMetricsRuntime } from "./runtime";

export type SellerMetricsApiEnv = AuthenticatedApiEnv;

export function buildSellerMetricsApi(sellerMetrics: ReturnType<typeof createSellerMetricsRuntime>) {
  const app = new Hono<SellerMetricsApiEnv>();

  app.route("/account/seller-metrics", createAccountSellerMetricsRoutes(sellerMetrics));
  app.route("/accounts", createPublicSellerMetricsRoutes(sellerMetrics));

  return app;
}
