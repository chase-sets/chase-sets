import { catalogProductMeasureSubscription } from "./features/product-measures/api/runtime";
import { defineBcProjectionGroupReset, type BcProjectionGroup } from "@chase-sets/bounded-context-module";
import { createCheckpointKey } from "@chase-sets/bounded-context-runtime";
import { resetProductMeasurePublicationParts, type PgQueryable } from "@chase-sets/event-core-postgres";
export { default as contextManifest } from "./context.json" with { type: "json" };

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import { catalogRetentionSweeps } from "./support/runtime-support/retention-policy";
import { buildCatalogAuthoringApi } from "./support/authoring-support";
import type { CatalogHostPorts, CatalogServices } from "./support/authoring-support";
import { createCatalogServices } from "./support/authoring-support";
import { catalogAuthoringSchemaMigrations, catalogAuthoringSchemaSql } from "./support/authoring-support";
import { catalogUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedCatalogDatabase } from "./support/authoring-support";
import { inspectCatalogSeedState } from "./support/seed-support/catalog-integration-state";
import { operatorSessionPublicRoutes } from "./features/operator-session/api/route";
import { createProviderScopeDiscoveryMcpHandlers } from "./features/provider-scope-discovery/api/mcp";
import { createProviderScopeMappingMcpHandlers } from "./features/provider-scope-mapping/api/mcp";
import { createReferenceDataMcpHandlers } from "./features/reference-data/api/mcp";
import { createScopeRegistryMcpHandlers } from "./features/scope-registry/api/mcp";
import { createScopeSyncBatchMcpHandlers } from "./features/scope-sync-batches/api/mcp";
import { createSourceObservationsMcpHandlers } from "./features/source-observations/api/mcp";

const baseModule = defineBoundedContextModule<CatalogServices, PgTransactionalPool, CatalogHostPorts>({
  manifest: contextManifest,
  schemaSql: catalogAuthoringSchemaSql,
  retentionSweeps: catalogRetentionSweeps,
  schemaMigrations: [...catalogUnloggedProjectionSchemaMigrations, ...catalogAuthoringSchemaMigrations],
  createServices: (pool, ports, options) => createCatalogServices(pool, ports, options),
  buildApis: (services) => [
    { mountPath: "/api/catalog", contextMountOrdinal: 1, router: buildCatalogAuthoringApi(services) },
    {
      mountPath: "/api/public/catalog/operator-session",
      contextMountOrdinal: 2,
      router: operatorSessionPublicRoutes(services.operatorSession),
    },
  ],
  buildMcpHandlers: (services) => {
    const discovery = createProviderScopeDiscoveryMcpHandlers(services.providerScopeDiscovery);
    const mappings = createProviderScopeMappingMcpHandlers(services.providerScopeMappings);
    const references = createReferenceDataMcpHandlers(services.referenceData);
    const registry = createScopeRegistryMcpHandlers(services.scopeRegistry);
    const batches = createScopeSyncBatchMcpHandlers(services.scopeSyncBatches);
    const observations = createSourceObservationsMcpHandlers(services.sourceObservations);
    return {
      toolHandlers: {
        ...discovery.toolHandlers,
        ...mappings.toolHandlers,
        ...references.toolHandlers,
        ...registry.toolHandlers,
        ...batches.toolHandlers,
        ...observations.toolHandlers,
      },
      resourceHandlers: {},
    };
  },
  projectionHandlerSets: (services) => services.projectors,
  seedProfiles: [
    "catalog-integration-bootstrap",
    "scenario-seed",
    "representative-commerce-state",
    "representative-catalog",
  ],
  seed: seedCatalogDatabase,
  inspectSeedState: (pool) => inspectCatalogSeedState(pool),
});

export const module = {
  ...baseModule,
  buildProjectionGroups: (): readonly BcProjectionGroup[] => [
    ...(baseModule.projectionGroups ?? []),
    {
      projectionName: catalogProductMeasureSubscription.projectionName,
      projectionRevision: 1,
      sourceContextNames: ["catalog"],
      ownedTables: [],
      requiredDuringBootstrap: false,
      reset: defineBcProjectionGroupReset(async (db: PgQueryable) => {
        await resetProductMeasurePublicationParts(db, createCheckpointKey(catalogProductMeasureSubscription));
      }),
    },
  ],
};
