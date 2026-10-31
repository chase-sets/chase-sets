import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { createPostgresPromotionTargetExclusion } from "../../features/source-observations/api/promotion/promotion-target-exclusion";
import { createCatalogProviderSendRuntime } from "../../features/source-observations/api/providers/provider-send-runtime";
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
import { createCatalogAttentionQueueRuntime } from "../../features/attention-queue/api/runtime";
import { createProviderScopeDiscoveryRuntime } from "../../features/provider-scope-discovery/api/runtime";
import { createProviderScopeMappingRuntime } from "../../features/provider-scope-mapping/api/runtime";
import { createReferenceDataRuntime } from "../../features/reference-data/api/runtime";
import { createCatalogScopeRegistryRuntime } from "../../features/scope-registry/api/runtime";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../features/source-observations/api/provider-integration-profile-store";
import { createSourceObservationRuntime } from "../../features/source-observations/api/runtime";
import { createScopeSyncBatchRuntime } from "../../features/scope-sync-batches/api/runtime";
import { createScopeSyncCountRuntime } from "../../features/scope-sync-batches/api/count-runtime";
import { createCountStore, countAccountSlot } from "../../features/scope-sync-batches/read-model/count-store";
import {
  createCountCaptureStore,
  readCountCaptureEffects,
} from "../../features/scope-sync-batches/read-model/count-capture-store";
import {
  createCountCaptureLifecycle,
  observeDeployedScrydexUsage,
  readCountCaptureRoster,
  readCountCaptureEvidence,
  type CountCaptureLifecycle,
} from "../../features/scope-sync-batches/api/count-capture-lifecycle";
import { createPgCatalogProviderOptionQueryCacheStore } from "../../features/source-observations/api/providers/provider-option-query-cache";
import { scrydexOnePieceCredentialsFromEnv } from "../../features/source-observations/api/providers/provider-option-queries";
import type { CatalogAssetStorage } from "../../features/source-observations/api/asset-storage";
import type { SourceObservationTelemetry } from "../../features/source-observations/api/catalog-integration-observability";
import { createCatalogAuthoringBulkJobServices } from "./bulk-authoring-jobs";
import { createOperatorSessionGrants, type CatalogOperatorAuthority } from "../../features/operator-session/api/grants";

export type CatalogHostPorts = Readonly<{
  catalogAssetStorage?: CatalogAssetStorage;
  sourceObservationTelemetry?: SourceObservationTelemetry;
  catalogOperatorAuthority?: CatalogOperatorAuthority;
}>;

export type CatalogServices = Readonly<{
  operatorSession: ReturnType<typeof createOperatorSessionGrants>;
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
  providerScopeDiscovery: ReturnType<typeof createProviderScopeDiscoveryRuntime>;
  providerIntegrationProfiles: ReturnType<typeof createCatalogProviderIntegrationProfileVersionStore>;
  sourceObservations: ReturnType<typeof createSourceObservationRuntime>;
  scopeSyncBatches: ReturnType<typeof createScopeSyncBatchRuntime>;
  // Dormant staging count capture; no other environment composes a capture store.
  countCapture: CountCaptureLifecycle | null;
  catalogAliases: ReturnType<typeof createCatalogAliasRuntime>;
  attentionQueue: ReturnType<typeof createCatalogAttentionQueueRuntime>;
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
  const countEnvironment = process.env.DEPLOYMENT_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim() || "runtime";
  const countAccountRevision = "runtime";
  const countStore = createCountStore(pool, countAccountSlot(countEnvironment, countAccountRevision));
  const deps = {
    scopeSyncCountState: { store: countStore, environment: countEnvironment, accountRevision: countAccountRevision },
    providerSendRuntime: createCatalogProviderSendRuntime(pool),
    eventStore,
    promotionTargetExclusion: createPostgresPromotionTargetExclusion({ pool, eventStore }),
    checkpointStore,
    db,
    notificationWaiterPool: options.notificationWaiterPool,
    assetStorage: ports.catalogAssetStorage,
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
  const sourceObservationRuntime = createSourceObservationRuntime(
    deps,
    items,
    referenceData,
    providerIntegrationProfiles,
    undefined,
    catalogAliases.upsertSourceObservationAliasCandidates,
    { catalogAliasCommandHandler: catalogAliases.catalogAliasCommandHandler },
    productContents,
  );
  const scopeSyncBatches = createScopeSyncBatchRuntime({
    db,
    counts: createScopeSyncCountRuntime({
      pool,
      store: countStore,
      environment: countEnvironment,
      accountRevision: countAccountRevision,
      profiles: providerIntegrationProfiles,
      providerSendRuntime: deps.providerSendRuntime,
      adapterOptions: {
        credentials: scrydexOnePieceCredentialsFromEnv(),
        profileVersions: providerIntegrationProfiles,
        cacheStore: createPgCatalogProviderOptionQueryCacheStore(db),
        countReader: countStore,
      },
    }),
    previewCatalogSyncScope: sourceObservationRuntime.previewCatalogSyncScope,
    enqueueCatalogSyncRun: sourceObservationRuntime.enqueueCatalogSyncRun,
    getCatalogSyncRun: sourceObservationRuntime.getCatalogSyncRun,
    cancelIntegrationJob: sourceObservationRuntime.cancelIntegrationJob,
  });
  const sourceObservations = {
    ...sourceObservationRuntime,
    processNextIntegrationJob: async (
      input: Parameters<typeof sourceObservationRuntime.processNextIntegrationJob>[0],
    ) => {
      const batchProcessed = await scopeSyncBatches.processNextScopeSyncBatch(input);
      const integrationProcessed = await sourceObservationRuntime.processNextIntegrationJob(input);
      return batchProcessed + integrationProcessed;
    },
  };
  const attentionQueue = createCatalogAttentionQueueRuntime(deps, {
    getReadiness: sourceObservations.getCatalogIntegrationControlPlaneReadiness,
    listActiveJobs: sourceObservations.listActiveIntegrationJobs,
  });
  const authoringBulkJobs = createCatalogAuthoringBulkJobServices(db);
  const providerScopeDiscovery = createProviderScopeDiscoveryRuntime(deps, {
    listProfileVersions: () => providerIntegrationProfiles.listProfileVersions(),
    queryIntegrationOptions: (input) => sourceObservations.queryIntegrationOptions(input),
    providerScopeMappingCommandHandler: providerScopeMappings.commandHandler,
  });

  return {
    operatorSession: createOperatorSessionGrants(pool, ports.catalogOperatorAuthority),
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
    providerScopeDiscovery,
    providerIntegrationProfiles,
    sourceObservations,
    scopeSyncBatches,
    countCapture:
      countEnvironment === "staging"
        ? createCountCaptureLifecycle({
            environment: countEnvironment,
            accountRevision: countAccountRevision,
            store: createCountCaptureStore(pool),
            readRoster: (scopeRecordId) => readCountCaptureRoster(db, providerIntegrationProfiles, scopeRecordId),
            readEffects: (at) => readCountCaptureEffects(db, at),
            countAuthority: () => countStore.authority(),
            observeUsage: observeDeployedScrydexUsage(
              sourceObservations.providerAdapterRegistry,
              deps.providerSendRuntime,
            ),
            counts: scopeSyncBatches,
            readCountEvidence: (quote) => readCountCaptureEvidence(db, countStore.slot, quote),
          })
        : null,
    catalogAliases,
    attentionQueue,
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
      ...attentionQueue.projectors,
    ],
    pool,
    db,
  };
}
