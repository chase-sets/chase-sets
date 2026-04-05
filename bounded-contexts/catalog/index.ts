export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildCatalogAuthoringApi } from "./authoring";
import type { CatalogServices } from "./authoring";
import { createCatalogServices } from "./authoring";
import { catalogAuthoringSchemaSql } from "./authoring";
import { seedCatalogDatabase } from "./authoring";

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
