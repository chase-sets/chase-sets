export { default as contextManifest } from "./context.json";
export { buildAuthApi } from "./api";
export type { AuthApiEnv } from "./api";
export {
  createAuthBootstrapContext,
  resolveActorFromRequest,
  resolveActorFromSessionToken,
} from "./runtime";
export {
  createAuthServices,
  revokeSession,
  startSessionForUser,
} from "./services";
export type { AuthServices } from "./services";
export type { ResolvedActor } from "@chase-sets/auth-context";

import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
import contextManifest from "./context.json";
import type { AuthServices } from "./services";
import { buildAuthApi } from "./api";

export function resolveApiMounts(services: AuthServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildAuthApi(services),
  ]);
}
