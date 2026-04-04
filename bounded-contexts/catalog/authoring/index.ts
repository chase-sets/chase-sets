export { CatalogDomainError } from "../common";
export { buildCatalogAuthoringApi } from "./api";
export type { CatalogAuthoringEnv } from "./api";
export { createCatalogServices } from "./services";
export type { CatalogServices } from "./services";
export { catalogAuthoringSchemaSql } from "./schema";
export { seedCatalogDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CatalogServices } from "./services";
import { buildCatalogAuthoringApi } from "./api";
import { createCatalogServices } from "./services";
import { catalogAuthoringSchemaSql } from "./schema";
import { seedCatalogDatabase } from "./seed";

export const module: BcApiModule<CatalogServices, PgTransactionalPool, void> = {
  contextName: "catalog",
  routePrefix: "/api/catalog",
  streamPrefix: "catalog.",
  schemaSql: catalogAuthoringSchemaSql,
  createServices: (pool) => createCatalogServices(pool),
  buildApi: buildCatalogAuthoringApi,
  projectors: (services) => services.projectors,
  seed: seedCatalogDatabase,
};
