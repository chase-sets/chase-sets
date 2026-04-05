export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
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
  apiMounts: contextManifest.apiMounts as BcApiModule<ReputationServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createReputationServices(pool),
  buildApis: (services) => [buildReputationApi(services)],
  projectors: (services) => services.projectors,
  seed: seedReputationDatabase,
};
