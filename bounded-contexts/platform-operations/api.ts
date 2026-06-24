import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import type { PlatformOperationsServices } from "./support/runtime-support/services";

export type PlatformOperationsApiEnv = AuthenticatedApiEnv;

export function buildPlatformOperationsApi(_services: PlatformOperationsServices) {
  return new Hono<PlatformOperationsApiEnv>();
}
