export { IdentityDomainError } from "./common";
export { buildIdentityApi } from "./api";
export { createBootstrapContext } from "./api";
export type { IdentityApiEnv } from "./api";
export { createIdentityServices } from "./services";
export type { IdentityServices } from "./services";
export { identitySchemaSql } from "./schema";
export { seedIdentityDatabase } from "./seed";

import type { BcModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { IdentityServices } from "./services";
import { buildIdentityApi } from "./api";
import { createIdentityServices } from "./services";
import { identitySchemaSql } from "./schema";
import { seedIdentityDatabase } from "./seed";

export const module: BcModule<IdentityServices, PgTransactionalPool> = {
  routePrefix: "/api/identity",
  schemaSql: identitySchemaSql,
  createServices: createIdentityServices,
  buildApi: buildIdentityApi,
  projectors: (services) => services.projectors,
  seed: seedIdentityDatabase,
};
