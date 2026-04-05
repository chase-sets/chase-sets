export { CatalogDomainError } from "../common";
export { buildCatalogAuthoringApi } from "./api";
export type { CatalogAuthoringEnv } from "./api";
export { createCatalogServices } from "./services";
export type { CatalogServices } from "./services";
export { catalogAuthoringSchemaSql } from "./schema";
export { seedCatalogDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "../context.json";
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
  apiMounts: contextManifest.apiMounts as BcApiModule<CatalogServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createCatalogServices(pool),
  buildApis: (services) => [buildCatalogAuthoringApi(services)],
  projectors: (services) => services.projectors,
  seed: seedCatalogDatabase,
};
