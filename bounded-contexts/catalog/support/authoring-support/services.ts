import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool, PgQueryable } from "@chase-sets/event-core-postgres";
import type { BcCreateServicesOptions } from "@chase-sets/bounded-context-module";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createCatalogAliasRuntime } from "../../features/alias-equivalence/api/runtime";
import { createBlueprintRuntime } from "../../features/blueprints/api/runtime";
import { createCatalogItemRuntime } from "../../features/catalog-items/api/runtime";
import { createCategoryRuntime } from "../../features/categories/api/runtime";
import { createComponentRuntime } from "../../features/components/api/runtime";
import { createDimensionRuntime } from "../../features/dimensions/api/runtime";
import { createDisplayTemplateRuntime } from "../../features/display-templates/api/runtime";
import { createFieldRuntime } from "../../features/fields/api/runtime";
import { createProductContentRuntime } from "../../features/product-contents/api/runtime";
import { createProductMeasureRuntime } from "../../features/product-measures/api/runtime";
import { createProviderScopeMappingRuntime } from "../../features/provider-scope-mapping/api/runtime";
import { createReferenceDataRuntime } from "../../features/reference-data/api/runtime";
import { createCatalogScopeRegistryRuntime } from "../../features/scope-registry/api/runtime";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../features/source-observations/api/provider-integration-profile-store";
import { createSourceObservationRuntime } from "../../features/source-observations/api/runtime";
import type { CatalogAssetStorage } from "../../features/source-observations/api/asset-storage";
import type { SourceObservationTelemetry } from "../../features/source-observations/api/catalog-integration-observability";
import type { TcgplayerAutomationCatalogClient } from "../../features/source-observations/api/tcgplayer-automation-catalog-client";
import { createCatalogAuthoringBulkJobServices } from "./bulk-authoring-jobs";

export type CatalogHostPorts = Readonly<{
  catalogAssetStorage?: CatalogAssetStorage;
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient;
  sourceObservationTelemetry?: SourceObservationTelemetry;
}>;

export type CatalogServices = Readonly<{
  dimensions: ReturnType<typeof createDimensionRuntime>;
  displayTemplates: ReturnType<typeof createDisplayTemplateRuntime>;
  fields: ReturnType<typeof createFieldRuntime>;
  referenceData: ReturnType<typeof createReferenceDataRuntime>;
  components: ReturnType<typeof createComponentRuntime>;
  blueprints: ReturnType<typeof createBlueprintRuntime>;
  categories: ReturnType<typeof createCategoryRuntime>;
  items: ReturnType<typeof createCatalogItemRuntime>;
  productContents: ReturnType<typeof createProductContentRuntime>;
  productMeasures: ReturnType<typeof createProductMeasureRuntime>;
  scopeRegistry: ReturnType<typeof createCatalogScopeRegistryRuntime>;
  providerScopeMappings: ReturnType<typeof createProviderScopeMappingRuntime>;
  providerIntegrationProfiles: ReturnType<typeof createCatalogProviderIntegrationProfileVersionStore>;
  sourceObservations: ReturnType<typeof createSourceObservationRuntime>;
  catalogAliases: ReturnType<typeof createCatalogAliasRuntime>;
  authoringBulkJobs: ReturnType<typeof createCatalogAuthoringBulkJobServices>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createCatalogServices(
  pool: PgTransactionalPool,
  ports: CatalogHostPorts = {},
  options: BcCreateServicesOptions<PgTransactionalPool> = {},
): CatalogServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "catalog" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = {
    eventStore,
    checkpointStore,
    db,
    notificationWaiterPool: options.notificationWaiterPool,
    assetStorage: ports.catalogAssetStorage,
    tcgplayerAutomationCatalogClient: ports.tcgplayerAutomationCatalogClient,
    sourceObservationTelemetry: ports.sourceObservationTelemetry,
  } as const;

  const dimensions = createDimensionRuntime(deps);
  const displayTemplates = createDisplayTemplateRuntime(deps);
  const fields = createFieldRuntime(deps);
  const referenceData = createReferenceDataRuntime(deps);
  const components = createComponentRuntime(deps);
  const blueprints = createBlueprintRuntime(deps);
  const categories = createCategoryRuntime(deps);
  const items = createCatalogItemRuntime(deps);
  const productContents = createProductContentRuntime(deps);
  const productMeasures = createProductMeasureRuntime(deps);
  const scopeRegistry = createCatalogScopeRegistryRuntime(deps);
  const providerScopeMappings = createProviderScopeMappingRuntime(deps);
  const providerIntegrationProfiles = createCatalogProviderIntegrationProfileVersionStore(db);
  const catalogAliases = createCatalogAliasRuntime(deps, {
    catalogItemCommandHandler: items.commandHandler,
    referenceRecordCommandHandler: referenceData.referenceRecordCommandHandler,
  });
  const sourceObservations = createSourceObservationRuntime(
    deps,
    items,
    referenceData,
    providerIntegrationProfiles,
    undefined,
    catalogAliases.upsertSourceObservationAliasCandidates,
    { catalogAliasCommandHandler: catalogAliases.catalogAliasCommandHandler },
    productContents,
  );
  const authoringBulkJobs = createCatalogAuthoringBulkJobServices(db);

  return {
    dimensions,
    displayTemplates,
    fields,
    referenceData,
    components,
    blueprints,
    categories,
    items,
    productContents,
    productMeasures,
    scopeRegistry,
    providerScopeMappings,
    providerIntegrationProfiles,
    sourceObservations,
    catalogAliases,
    authoringBulkJobs,
    projectors: [
      ...dimensions.projectors,
      ...displayTemplates.projectors,
      ...fields.projectors,
      ...referenceData.projectors,
      ...components.projectors,
      ...blueprints.projectors,
      ...categories.projectors,
      ...items.projectors,
      ...productContents.projectors,
      ...productMeasures.projectors,
      ...scopeRegistry.projectors,
      ...providerScopeMappings.projectors,
      ...sourceObservations.projectors,
      ...catalogAliases.projectors,
    ],
    pool,
    db,
  };
}
