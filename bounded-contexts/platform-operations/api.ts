import { Hono } from "hono";
import type { PlatformOperationsServices } from "./support/runtime-support/services";
import {
  createReleaseControlsPolicyRoutes,
  type PlatformOperationsApiEnv,
} from "./features/release-controls/api/route";

export type { PlatformOperationsApiEnv };

export function buildPlatformOperationsApi(services: PlatformOperationsServices) {
  const app = new Hono<PlatformOperationsApiEnv>();
  app.route("/release-controls", createReleaseControlsPolicyRoutes(services.releaseControls));
  return app;
}
