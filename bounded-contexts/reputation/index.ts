export { ReputationDomainError } from "./common";
export { buildReputationApi } from "./api";
export type { ReputationApiEnv } from "./api";
export { createReputationServices } from "./services";
export type { ReputationServices } from "./services";
export { reputationSchemaSql } from "./schema";
export { seedReputationDatabase } from "./seed";

import type { BcModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ReputationServices } from "./services";
import { buildReputationApi } from "./api";
import { createReputationServices } from "./services";
import { reputationSchemaSql } from "./schema";
import { seedReputationDatabase } from "./seed";

export const module: BcModule<ReputationServices, PgTransactionalPool> = {
  routePrefix: "/api/marketplace",
  schemaSql: reputationSchemaSql,
  createServices: createReputationServices,
  buildApi: buildReputationApi,
  projectors: (services) => services.projectors,
  seed: seedReputationDatabase,
};
