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
  type AuthServicePorts,
  revokeSession,
  startSessionForUser,
} from "./services";
export type { AuthServices } from "./services";
export type { ResolvedActor } from "@chase-sets/auth-context";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { AuthServicePorts, AuthServices } from "./services";
import { createAuthServices } from "./services";
import { buildAuthApi } from "./api";

export const module: BcApiModule<AuthServices, PgTransactionalPool, AuthServicePorts> = {
  contextName: "auth",
  routePrefix: "/api/auth",
  streamPrefix: "auth.",
  schemaSql: "",
  createServices: (pool, ports) => createAuthServices(pool, ports),
  buildApi: buildAuthApi,
  projectors: (services) => services.projectors,
};

export function resolveApiMounts(services: AuthServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildAuthApi(services),
  ]);
}
