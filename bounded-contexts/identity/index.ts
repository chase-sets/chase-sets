export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
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
  apiMounts: contextManifest.apiMounts as BcApiModule<IdentityServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createIdentityServices(pool),
  buildApis: (services) => [buildIdentityApi(services)],
  projectors: (services) => services.projectors,
  seed: seedIdentityDatabase,
};
