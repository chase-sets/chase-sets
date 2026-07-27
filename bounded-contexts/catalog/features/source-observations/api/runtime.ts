import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ProductContentServices } from "../../product-contents/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationEvent,
} from "../domain/domain";
import { buildSourceObservationProjectionHandlers } from "../read-model/projection";
import {
  getSourceObservationDetail,
  listCatalogMergeCandidates,
  listSourceObservations,
  listSourceObservationIntegrationScopes,
} from "../read-model/queries";
import { upsertSourceObservationAliasCandidates } from "../../alias-equivalence/read-model/projection";
import { createPostgresDurableJobStore } from "@chase-sets/platform-runtime/durable-job-store";
import { createPostgresDurableJobWorkUnitStore } from "@chase-sets/platform-runtime/durable-job-work-units";
import { createCatalogIntegrationDryRunProofRegistry } from "./catalog-integration-dry-run-proofs";
import {
  createCatalogIntegrationRolloutControlPolicyFromEnv,
  type CatalogIntegrationRolloutControlPolicy,
} from "./catalog-integration-rollout-controls";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import { createReferenceCardsProviderAdapter } from "./provider-adapters/reference-cards";
import { createTcgdexProviderAdapter } from "./provider-adapters/tcgdex";
import { createTcgplayerProviderAdapter } from "./provider-adapters/tcgplayer";
import { createMtgjsonProviderAdapter } from "./provider-adapters/mtgjson";
import { createLorcanajsonProviderAdapter } from "./provider-adapters/lorcanajson";
import { createLorcastProviderAdapter } from "./provider-adapters/lorcast";
import { createScryfallProviderAdapter } from "./provider-adapters/scryfall";
import { createYgoprodeckProviderAdapter } from "./provider-adapters/ygoprodeck";
import { createYgojsonProviderAdapter } from "./provider-adapters/ygojson";
import { createScrydexOnePieceProviderAdapter } from "./provider-adapters/scrydex-one-piece";
import { normalizeCatalogControlPlaneTelemetryEvent } from "./catalog-integration-observability";
import { staticCatalogProviderIntegrationProfileVersions } from "./source-observation-runtime-contracts";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  CatalogSyncRunFanoutProgress,
  CatalogSyncRunFanoutResult,
  CatalogSyncRunPayload,
  BulkSourceObservationProgress,
  SourceObservationAliasCandidateSink,
  SourceObservationAliasPromotion,
  SourceObservationBulkJob,
  SourceObservationBulkJobPayload,
  SourceObservationBulkJobResult,
  SourceObservationBulkWorkUnitPayload,
  SourceObservationBulkWorkUnitResult,
  SourceObservationIntegrationJob,
  SourceObservationIntegrationJobOutcome,
  SourceObservationIntegrationJobPayload,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationWorkUnitPayload,
  SourceObservationServices,
} from "./source-observation-runtime-contracts";
import {
  scrydexOnePieceCredentialsFromEnv,
  listTcgdexLanguagesThroughAdapter,
  listTcgdexSeriesThroughAdapter,
  listTcgdexExpansionsThroughAdapter,
  queryProviderIntegrationOptions,
  listProviderIntegrationOptions,
} from "./provider-option-queries";
import {
  loadSelectedOptionAuthoringSchema,
  loadPromotionTargetAuthoringSchema,
} from "./catalog-integration-control-plane-readiness";
import {
  toSourceObservationBulkJobEventSnapshot,
  toSourceObservationIntegrationJobEventSnapshot,
  toCatalogSyncRunFanoutEventSnapshot,
  sourceObservationRetentionCutoff,
} from "./source-observation-job-serialization";
import { requireCatalogImportProfileVersion } from "./source-observation-promotion-execution";
import { createSourceObservationMergeCandidateRuntime } from "./source-observation-merge-candidate-runtime";
import { createSourceObservationPromotionReapplyRuntime } from "./source-observation-promotion-reapply-runtime";
import { createSourceObservationProviderImportRuntime } from "./source-observation-provider-import-runtime";
import {
  createCatalogScopeSyncStateRuntime,
  createCatalogSyncRunFanoutRuntime,
} from "./source-observation-catalog-sync-run-runtime";
import { createSourceObservationIntegrationJobRuntime } from "./source-observation-integration-job-runtime";
import { createSourceObservationBulkReviewJobRuntime } from "./source-observation-bulk-review-job-runtime";
import { createSourceObservationIntegrationEngineRuntime } from "./source-observation-integration-engine-runtime";
export {
  ensurePokemonReferenceHierarchy,
  resolvePokemonReferenceHierarchy,
  resolveYugiohSealedProductSetReference,
} from "./source-observation-promotion-reference-hierarchy";
export {
  prepareProviderAdapterSourceObservationPayload,
  requireSourceObservationMappingContract,
} from "./source-observation-promotion-execution";
export type {
  BulkSourceObservationPromotionOutcome,
  BulkSourceObservationPromotionResult,
  BulkSourceObservationReapplyOutcome,
  BulkSourceObservationReapplyResult,
  BulkSourceObservationProgress,
  SourceObservationBulkJobAction,
  SourceObservationBulkJobStatus,
  SourceObservationBulkJob,
  SourceObservationJobEvent,
  SourceObservationPromotionOutcomeRecord,
  SourceObservationBulkJobResult,
  SourceObservationJobRunContext,
  SourceObservationIntegrationJobAction,
  SourceObservationReapplyProfileMode,
  SourceObservationIntegrationJobScope,
  RepresentativeCatalogProductAssetSource,
  SourceObservationIntegrationProfileSnapshot,
  SourceObservationIntegrationJobOutcome,
  SourceObservationProviderUsageEvidence,
  SourceObservationIntegrationImportPreviewTarget,
  SourceObservationIntegrationImportPreview,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationJobOperatorStatus,
  SourceObservationIntegrationJobLifecycleCommandErrorCode,
  SourceObservationIntegrationJobConsistency,
  SourceObservationIntegrationJob,
  CatalogSyncRunChildStatus,
  CatalogSyncRunOperatorStatus,
  CatalogSyncRunSelectedUnitSnapshot,
  CatalogSyncRunChildJobLink,
  CatalogSyncRunChildJob,
  CatalogSyncRunProgress,
  CatalogSyncRunConsistency,
  CatalogSyncRun,
  SourceObservationIntegrationOption,
  SourceObservationSelectedOptionAuthoringSchema,
  SourceObservationPromotionTargetAuthoringSchema,
  SourceObservationPromotionTargetAuthoringRecord,
  SourceObservationDuplicatePreventionCandidatePreview,
  CatalogIntegrationControlPlaneReadiness,
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogIntegrationControlPlaneDiagnostic,
  CatalogIntegrationControlPlaneDryRunEvidence,
  SourceObservationCommandServices,
  ProviderAdapterServices,
  ProviderOptionQueryServices,
  ProviderProfileAdminServices,
  CatalogIntegrationEngineServices,
  SourceObservationReviewServices,
  PromotionReapplyServices,
  BulkReviewJobServices,
  CatalogScopeSyncUnitStateReadModel,
  IntegrationJobServices,
  SourceObservationReadServices,
  CatalogMergeCandidateGenerationResult,
  CatalogMergeCandidateActionResult,
  CatalogMergeCandidateServices,
  ControlPlaneTelemetryServices,
  SourceObservationRetentionServices,
  SourceObservationProjectorServices,
  SourceObservationServices,
  SourceObservationAliasCandidateSink,
  SourceObservationAliasPromotion,
} from "./source-observation-runtime-contracts";
export {
  SourceObservationIntegrationJobLifecycleCommandError,
  isSourceObservationIntegrationJobLifecycleCommandError,
} from "./source-observation-runtime-contracts";

/**
 * Composition root for the Source Observation slice. Everything here is
 * wiring: build the shared substrate (aggregate command handler, projectors,
 * durable job stores, provider adapter registry), compose the facet-aligned
 * sub-runtimes over it, and assemble the single `SourceObservationServices`
 * surface the routes and composition roots consume. Domain behavior lives in
 * the sub-runtime modules imported above.
 */
export function createSourceObservationRuntime(
  deps: CatalogRuntimeDeps,
  items: CatalogItemServices,
  referenceData: ReferenceDataServices,
  profileVersions: CatalogProviderIntegrationProfileVersionReader = staticCatalogProviderIntegrationProfileVersions,
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy = createCatalogIntegrationRolloutControlPolicyFromEnv(),
  aliasCandidateSink: SourceObservationAliasCandidateSink = (candidates, observedAt) =>
    upsertSourceObservationAliasCandidates(deps.db, candidates, observedAt),
  aliasPromotion: SourceObservationAliasPromotion | null = null,
  productContents: ProductContentServices | null = null,
): SourceObservationServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
    initialState: () => initialSourceObservationState,
    evolve: evolveSourceObservation,
    decide: decideSourceObservation,
  });
  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-source-observation-projection",
      handlers: withCatalogAdminRealtimeInvalidation(buildSourceObservationProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-source-observation-projection",
        surface: "source-observations",
        shouldInvalidate: shouldInvalidateSourceObservationEvent,
      }),
    }),
  ];
  const bulkReviewJobStore = createPostgresDurableJobStore<
    SourceObservationBulkJobPayload,
    BulkSourceObservationProgress,
    SourceObservationBulkJobResult,
    SourceObservationBulkJob
  >(
    deps.db,
    {
      jobsTable: "catalog_source_observation_bulk_review_jobs",
      eventsTable: "catalog_source_observation_bulk_review_job_events",
      notifyChannel: "catalog_source_observation_durable_job_events",
    },
    {
      eventSnapshot: toSourceObservationBulkJobEventSnapshot,
      notificationWaiterPool: deps.notificationWaiterPool,
    },
  );
  const bulkReviewWorkUnitStore = createPostgresDurableJobWorkUnitStore<
    SourceObservationBulkJobPayload,
    BulkSourceObservationProgress,
    SourceObservationBulkJobResult,
    SourceObservationBulkWorkUnitPayload,
    SourceObservationBulkWorkUnitResult,
    SourceObservationBulkJob
  >(
    deps.db,
    {
      jobsTable: "catalog_source_observation_bulk_review_jobs",
      eventsTable: "catalog_source_observation_bulk_review_job_events",
      workUnitsTable: "catalog_source_observation_bulk_review_work_units",
      notifyChannel: "catalog_source_observation_durable_job_events",
    },
    {
      workflowName: "catalog.source-observation-bulk-review",
      eventSnapshot: toSourceObservationBulkJobEventSnapshot,
    },
  );
  const integrationJobStore = createPostgresDurableJobStore<
    SourceObservationIntegrationJobPayload,
    BulkSourceObservationProgress,
    SourceObservationIntegrationJobResult,
    SourceObservationIntegrationJob
  >(
    deps.db,
    {
      jobsTable: "catalog_source_observation_integration_durable_jobs",
      eventsTable: "catalog_source_observation_integration_job_events",
      notifyChannel: "catalog_source_observation_durable_job_events",
    },
    {
      eventSnapshot: toSourceObservationIntegrationJobEventSnapshot,
      notificationWaiterPool: deps.notificationWaiterPool,
    },
  );
  const catalogSyncRunStore = createPostgresDurableJobStore<
    CatalogSyncRunPayload,
    CatalogSyncRunFanoutProgress,
    CatalogSyncRunFanoutResult
  >(
    deps.db,
    {
      jobsTable: "catalog_source_observation_integration_durable_jobs",
      eventsTable: "catalog_source_observation_integration_job_events",
      notifyChannel: "catalog_source_observation_durable_job_events",
    },
    {
      eventSnapshot: toCatalogSyncRunFanoutEventSnapshot,
      notificationWaiterPool: deps.notificationWaiterPool,
    },
  );
  const integrationWorkUnitStore = createPostgresDurableJobWorkUnitStore<
    SourceObservationIntegrationJobPayload,
    BulkSourceObservationProgress,
    SourceObservationIntegrationJobResult,
    SourceObservationIntegrationWorkUnitPayload,
    SourceObservationIntegrationJobOutcome,
    SourceObservationIntegrationJob
  >(
    deps.db,
    {
      jobsTable: "catalog_source_observation_integration_durable_jobs",
      eventsTable: "catalog_source_observation_integration_job_events",
      workUnitsTable: "catalog_source_observation_integration_work_units",
      notifyChannel: "catalog_source_observation_durable_job_events",
    },
    {
      workflowName: "catalog.source-observation-integration",
      eventSnapshot: toSourceObservationIntegrationJobEventSnapshot,
    },
  );
  const providerAdapterRegistry = new ProviderAdapterRegistry([
    createReferenceCardsProviderAdapter(),
    createTcgdexProviderAdapter({
      loadActiveProfileVersion: () => requireCatalogImportProfileVersion(profileVersions, "tcgdex"),
    }),
    createTcgplayerProviderAdapter({
      loadProfileVersions: () => profileVersions.listProfileVersions("tcgplayer"),
      client: deps.tcgplayerAutomationCatalogClient,
    }),
    createMtgjsonProviderAdapter(),
    createLorcanajsonProviderAdapter(),
    createLorcastProviderAdapter(),
    createScryfallProviderAdapter(),
    createYgoprodeckProviderAdapter(),
    createYgojsonProviderAdapter(),
    createScrydexOnePieceProviderAdapter({ credentials: scrydexOnePieceCredentialsFromEnv() }),
  ]);
  const dryRunProofRegistry = createCatalogIntegrationDryRunProofRegistry();

  const mergeCandidates = createSourceObservationMergeCandidateRuntime({ deps, profileVersions });
  const promotionReapply = createSourceObservationPromotionReapplyRuntime({
    deps,
    items,
    referenceData,
    productContents,
    profileVersions,
    rolloutControlPolicy,
    aliasPromotion,
    commandHandler,
  });
  const providerImport = createSourceObservationProviderImportRuntime({
    deps,
    items,
    referenceData,
    aliasCandidateSink,
    commandHandler,
    providerAdapterRegistry,
    mergeCandidates,
  });
  const scopeSyncState = createCatalogScopeSyncStateRuntime({
    deps,
    profileVersions,
    rolloutControlPolicy,
    providerAdapterRegistry,
    integrationJobStore,
    catalogSyncRunStore,
  });
  const integrationJobs = createSourceObservationIntegrationJobRuntime({
    deps,
    profileVersions,
    rolloutControlPolicy,
    integrationJobStore,
    integrationWorkUnitStore,
    promotionReapply,
    scopeSyncState,
    providerImport,
  });
  const catalogSyncRuns = createCatalogSyncRunFanoutRuntime({
    catalogSyncRunStore,
    scopeSyncState,
    enqueueIntegrationJob: integrationJobs.enqueueIntegrationJob,
  });
  const bulkReviewJobs = createSourceObservationBulkReviewJobRuntime({
    deps,
    profileVersions,
    rolloutControlPolicy,
    bulkReviewJobStore,
    bulkReviewWorkUnitStore,
    promotionReapply,
  });
  const integrationEngine = createSourceObservationIntegrationEngineRuntime({
    deps,
    items,
    referenceData,
    productContents,
    profileVersions,
    rolloutControlPolicy,
    providerAdapterRegistry,
    dryRunProofRegistry,
    bulkReviewJobStore,
    integrationJobStore,
    providerImport,
  });

  return {
    commandHandler,
    ...mergeCandidates.services,
    providerAdapterRegistry,
    listTcgdexLanguages: () => {
      rolloutControlPolicy.assertAllowed({ capability: "provider-option-query", providerKey: "tcgdex" });
      return listTcgdexLanguagesThroughAdapter(providerAdapterRegistry);
    },
    listTcgdexSeries: ({ languageCode }) => {
      rolloutControlPolicy.assertAllowed({ capability: "provider-option-query", providerKey: "tcgdex" });
      return listTcgdexSeriesThroughAdapter(providerAdapterRegistry, { languageCode });
    },
    listTcgdexExpansions: ({ languageCode, seriesId }) => {
      rolloutControlPolicy.assertAllowed({ capability: "provider-option-query", providerKey: "tcgdex" });
      return listTcgdexExpansionsThroughAdapter(providerAdapterRegistry, { languageCode, seriesId });
    },
    queryIntegrationOptions: (input) =>
      queryProviderIntegrationOptions(
        input,
        deps.db,
        rolloutControlPolicy,
        deps.tcgplayerAutomationCatalogClient,
        profileVersions,
        providerAdapterRegistry,
        deps.sourceObservationTelemetry,
      ),
    listIntegrationOptions: (input) => {
      rolloutControlPolicy.assertAllowed({
        capability: "provider-option-query",
        providerKey: input.providerKey,
      });
      return listProviderIntegrationOptions(
        input,
        deps.tcgplayerAutomationCatalogClient,
        profileVersions,
        providerAdapterRegistry,
      );
    },
    getSelectedOptionAuthoringSchema: async () => loadSelectedOptionAuthoringSchema(deps.db),
    getPromotionTargetAuthoringSchema: async () => loadPromotionTargetAuthoringSchema(deps.db),
    ...integrationEngine.services,
    ...promotionReapply.services,
    ...bulkReviewJobs.services,
    ...scopeSyncState.services,
    ...catalogSyncRuns.services,
    ...integrationJobs.services,
    listSourceObservations: (params) => listSourceObservations(deps.db, params),
    listCatalogMergeCandidates: (params) => listCatalogMergeCandidates(deps.db, params),
    listIntegrationScopes: (params) => listSourceObservationIntegrationScopes(deps.db, params),
    pruneSourceObservationJobRetention: async (input = {}) => {
      const completedBefore = input.completedBefore ?? sourceObservationRetentionCutoff(7);
      const [bulkReviewJobsPruned, integrationJobsPruned] = await Promise.all([
        bulkReviewJobStore.pruneTerminalJobs({ completedBefore, limit: input.limit }),
        integrationJobStore.pruneTerminalJobs({ completedBefore, limit: input.limit }),
      ]);

      return { bulkReviewJobs: bulkReviewJobsPruned, integrationJobs: integrationJobsPruned };
    },
    getSourceObservationDetail: (observationId) => getSourceObservationDetail(deps.db, observationId),
    recordControlPlaneTelemetry: (event) => {
      deps.sourceObservationTelemetry?.recordControlPlaneEvent?.(normalizeCatalogControlPlaneTelemetryEvent(event));
    },
    projectors,
  };
}

function shouldInvalidateSourceObservationEvent(eventType: string, event: { data: unknown }): boolean {
  if (
    (eventType === "catalog.source-observation.recorded" ||
      eventType === "catalog.source-observation.changed" ||
      eventType === "catalog.source-observation.refreshed") &&
    hasSourcePayloadChunkCount(event.data)
  ) {
    return false;
  }

  if (eventType !== "catalog.source-observation.source-payload-chunk-recorded") {
    return true;
  }

  const data = event.data as { chunkIndex?: unknown; chunkCount?: unknown };
  return (
    typeof data.chunkIndex === "number" &&
    typeof data.chunkCount === "number" &&
    data.chunkIndex + 1 === data.chunkCount
  );
}

function hasSourcePayloadChunkCount(value: unknown): boolean {
  return !!value && typeof value === "object" && "sourcePayloadChunkCount" in value;
}
