export { ReputationDomainError } from "./common";
export { default as contextManifest } from "./context.json";
export { buildReputationApi } from "./api";
export type { ReputationApiEnv } from "./api";
export { createReputationServices } from "./services";
export type { ReputationServices } from "./services";
export { reputationSchemaSql } from "./schema";
export { seedReputationDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { ReputationServices } from "./services";
import { buildReputationApi } from "./api";
import { createReputationServices } from "./services";
import { reputationSchemaSql } from "./schema";
import { seedReputationDatabase } from "./seed";

export const module: BcApiModule<ReputationServices, PgTransactionalPool, void> = {
  contextName: "reputation",
  routePrefix: "/api/marketplace",
  streamPrefix: "reputation.",
  schemaSql: reputationSchemaSql,
  createServices: (pool) => createReputationServices(pool),
  buildApi: buildReputationApi,
  projectors: (services) => services.projectors,
  seed: seedReputationDatabase,
};

export function resolveApiMounts(services: ReputationServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildReputationApi(services),
  ]);
}
