export { IdentityDomainError } from "./common";
export { default as contextManifest } from "./context.json";
export { buildIdentityApi } from "./api";
export { createBootstrapContext } from "./api";
export type { IdentityApiEnv } from "./api";
export { createIdentityServices } from "./services";
export type { IdentityServices } from "./services";
export { identitySchemaSql } from "./schema";
export { seedIdentityDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { IdentityServices } from "./services";
import { buildIdentityApi } from "./api";
import { createIdentityServices } from "./services";
import { identitySchemaSql } from "./schema";
import { seedIdentityDatabase } from "./seed";

export const module: BcApiModule<IdentityServices, PgTransactionalPool, void> = {
  contextName: "identity",
  routePrefix: "/api/identity",
  streamPrefix: "identity.",
  schemaSql: identitySchemaSql,
  createServices: (pool) => createIdentityServices(pool),
  buildApi: buildIdentityApi,
  projectors: (services) => services.projectors,
  seed: seedIdentityDatabase,
};

export function resolveApiMounts(services: IdentityServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildIdentityApi(services),
  ]);
}
