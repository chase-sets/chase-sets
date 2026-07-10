export { CatalogDomainError } from "../runtime-support/common";
export { buildCatalogAuthoringApi } from "./api";
export type { CatalogAuthoringEnv } from "./api";
export { createCatalogServices } from "./services";
export type { CatalogHostPorts, CatalogServices } from "./services";
export { catalogAuthoringSchemaMigrations, catalogAuthoringSchemaSql } from "./schema";
export { seedCatalogDatabase } from "./seed";

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "../../context.json";
import type { CatalogHostPorts, CatalogServices } from "./services";
import { buildCatalogAuthoringApi } from "./api";
import { createCatalogServices } from "./services";
import { catalogAuthoringSchemaMigrations, catalogAuthoringSchemaSql } from "./schema";
import { seedCatalogDatabase } from "./seed";

export const module = defineBoundedContextModule<CatalogServices, PgTransactionalPool, CatalogHostPorts>({
  manifest: contextManifest,
  schemaSql: catalogAuthoringSchemaSql,
  schemaMigrations: catalogAuthoringSchemaMigrations,
  createServices: (pool, ports) => createCatalogServices(pool, ports),
  buildApis: (services) => [buildCatalogAuthoringApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  seedProfiles: ["catalog-integration-bootstrap", "scenario-seed", "representative-commerce-state"],
  seed: seedCatalogDatabase,
});
