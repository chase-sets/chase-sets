export { default as contextManifest } from "./context.json";

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { catalogRetentionSweeps } from "./support/runtime-support/retention-policy";
import { buildCatalogAuthoringApi } from "./support/authoring-support";
import type { CatalogHostPorts, CatalogServices } from "./support/authoring-support";
import { createCatalogServices } from "./support/authoring-support";
import { catalogAuthoringSchemaMigrations, catalogAuthoringSchemaSql } from "./support/authoring-support";
import { catalogUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedCatalogDatabase } from "./support/authoring-support";

export const module = defineBoundedContextModule<CatalogServices, PgTransactionalPool, CatalogHostPorts>({
  manifest: contextManifest,
  schemaSql: catalogAuthoringSchemaSql,
  retentionSweeps: catalogRetentionSweeps,
  schemaMigrations: [...catalogUnloggedProjectionSchemaMigrations, ...catalogAuthoringSchemaMigrations],
  createServices: (pool, ports, options) => createCatalogServices(pool, ports, options),
  buildApis: (services) => [buildCatalogAuthoringApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  seedProfiles: ["catalog-integration-bootstrap", "scenario-seed", "representative-commerce-state"],
  seed: seedCatalogDatabase,
});
