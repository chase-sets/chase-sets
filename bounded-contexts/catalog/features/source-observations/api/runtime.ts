import { createHash } from "node:crypto";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  isDurableJobHandoffError,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  type DurableJobWorkUnitRecord,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { toJsonValue, type JsonValue } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { CatalogItemCommand } from "../../catalog-items/domain/domain";
import type { ProductContentServices } from "../../product-contents/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRelationship } from "../../reference-data/domain/domain";
import {
  catalogScopeSyncUnitIsFastForwardable,
  computeCatalogSyncScopeKey,
  type CatalogScopeSyncUnitObservedStatus,
  type CatalogScopeSyncUnitState,
} from "../../scope-sync-state/domain/state";
import {
  listCatalogScopeSyncState,
  readCatalogScopeSyncUnitState,
  upsertCatalogScopeSyncUnitState,
} from "../../scope-sync-state/read-model/queries";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  isLorcanaCatalogItemSourceObservationNormalized,
  isLorcanaSetReferenceSourceObservationNormalized,
  isMagicCatalogItemSourceObservationNormalized,
  isMagicSetReferenceSourceObservationNormalized,
  isOnePieceCatalogItemSourceObservationNormalized,
  isOnePieceSetReferenceSourceObservationNormalized,
  isPokemonCardSourceObservationNormalized,
  isPokemonCatalogItemSourceObservationNormalized,
  isYugiohCatalogItemSourceObservationNormalized,
  type SourceObservationEvent,
  type SourceObservationLorcanaCardPrintNormalized,
  type SourceObservationLorcanaSetReferenceNormalized,
  type SourceObservationLorcanaSealedProductNormalized,
  type SourceObservationMagicCardPrintNormalized,
  type SourceObservationMagicSetReferenceNormalized,
  type SourceObservationMagicSealedProductNormalized,
  type SourceObservationNormalized,
  type SourceObservationOnePieceCardPrintNormalized,
  type SourceObservationOnePieceSetReferenceNormalized,
  type SourceObservationOnePieceSealedProductNormalized,
  type SourceObservationPokemonCardNormalized,
  type SourceObservationPokemonSealedProductNormalized,
  type SourceObservationYugiohSealedProductNormalized,
  type SourceObservationPromotionProfileEvidence,
} from "../domain/domain";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateCommand,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidateReviewActor,
  type CatalogMergeCandidateReviewSnapshot,
} from "../domain/catalog-merge-candidate";
import { buildSourceObservationProjectionHandlers } from "../read-model/projection";
import {
  getSourceObservationDetail,
  listCatalogMergeCandidates,
  listSourceObservationsForCandidateMatching,
  listSourceObservationIdsForReapply,
  listSourceObservationIdsForPromotion,
  listSourceObservationIntegrationScopes,
  listSourceObservations,
  previewSourceObservationPromotionIds,
  previewSourceObservationReapplyScope,
  previewSourceObservationPromotionScope,
  summarizeSourceObservationLifecycleImpact,
  summarizeSourceObservationReplayImpact,
  type SourceObservationDetailRow,
  type SourceObservationFilterScope,
  type SourceObservationListRow,
} from "../read-model/queries";
import {
  buildCatalogMergeCandidatesFromObservations,
  type CatalogMergeCandidateMatchBatch,
} from "./catalog-merge-candidate-matcher";
import {
  listAcceptedProviderScopeMappingsByScopeRecord,
  listAcceptedProviderScopeMappingsForProviders,
} from "../../provider-scope-mapping/read-model/queries";
import { planCatalogMergeCandidatePromotionCommands } from "./catalog-merge-candidate-promotion-planner";
import { normalizeTcgdexImageAsset, type TcgdexObservationPayload } from "./tcgdex-client";
import {
  extractApprovedLorcanaImageEvidence,
  normalizeLorcanaImageAsset,
  normalizeProductAssetSet,
} from "./product-asset-normalization";
import { ingestTcgdexAliasCandidates } from "./tcgdex-alias-intake";
import { upsertSourceObservationAliasCandidates } from "../../alias-equivalence/read-model/projection";
import { writePromotionAliases, type PromotionAliasServices } from "./provider-promotion-alias-writer";
import { createPromotionAliasReader } from "./provider-promotion-alias-reader";
import type { PromotionAliasTargetResolution } from "./provider-promotion-alias-planner";
import {
  buildTcgplayerAutomationSourceObservationPayload,
  type TcgplayerAutomationProductDetail,
} from "./tcgplayer-automation-catalog-client";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  getCatalogProviderIntegrationProfileVersion,
  type CatalogProviderIntegrationProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import {
  catalogProviderSourceMappingFingerprint,
  normalizeCatalogProviderSourceObservation,
  requireCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import { createCatalogIntegrationDryRunProofRegistry } from "./catalog-integration-dry-run-proofs";
import {
  createCatalogIntegrationRolloutControlPolicyFromEnv,
  type CatalogIntegrationRolloutControlPolicy,
} from "./catalog-integration-rollout-controls";
import {
  buildCatalogLifecycleImpactReadModel,
  buildCatalogReplayReapplyImpactReadModel,
  toCatalogAdminProfileVersionPointer,
  unitKeyForCatalogProviderProfileVersion,
  type CatalogIntegrationImpactJobSample,
} from "./catalog-integration-impact-analysis";
import {
  catalogSyncAcceptedScopeMappingFromRow,
  normalizeCatalogSyncScope,
  previewCatalogSyncProviderParticipation,
  type CatalogSyncAcceptedScopeMapping,
  type CatalogSyncProviderParticipationPreview,
  type CatalogSyncScope,
} from "./catalog-sync-scope-planner";
import type {
  CatalogAdminReplayReapplyImpactSummaryReadModel,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
} from "./admin-control-plane-read-model-contracts";
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
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderPayloadEnvelope,
} from "./provider-adapters/provider-adapter";
import {
  listCatalogProviderIntegrationOptionsFromProfiles,
  type CatalogProviderIntegrationOption,
} from "./provider-option-query-resolver";
import { normalizeCatalogControlPlaneTelemetryEvent } from "./catalog-integration-observability";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionResolvedCatalogMapping,
  type CatalogProviderPromotionCommandPlanResult,
} from "./provider-promotion-command-planner";
import { resolveCatalogProviderDuplicatePrevention } from "./provider-duplicate-prevention-resolver";
import { provisionCatalogProviderReferenceHierarchy } from "./provider-reference-hierarchy-provisioner";
import {
  staticCatalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionLookupKey,
  SourceObservationIntegrationJobLifecycleCommandError,
  OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE,
} from "./source-observation-runtime-contracts";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationAliasCandidateSink,
  SourceObservationAliasPromotion,
  SourceObservationServices,
  SourceObservationBulkJobPayload,
  BulkSourceObservationProgress,
  SourceObservationBulkJobResult,
  SourceObservationBulkJob,
  SourceObservationBulkWorkUnitPayload,
  SourceObservationBulkWorkUnitResult,
  SourceObservationIntegrationJobPayload,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationJob,
  CatalogSyncRunPayload,
  CatalogSyncRunFanoutProgress,
  CatalogSyncRunFanoutResult,
  SourceObservationIntegrationWorkUnitPayload,
  SourceObservationIntegrationJobOutcome,
  SourceObservationRecordInput,
  CatalogMergeCandidateGenerationResult,
  CatalogMergeCandidateActionResult,
  SourceObservationDuplicatePreventionCandidatePreview,
  RepresentativeCatalogProductAssetSource,
  SourceObservationPromotionTargetResult,
  SourceObservationProgressHandler,
  DurableSideEffectRunner,
  BulkSourceObservationPromotionResult,
  BulkSourceObservationPromotionOutcome,
  SourceObservationReapplyProfileMode,
  SourceObservationIntegrationProfileSnapshot,
  BulkSourceObservationReapplyResult,
  BulkSourceObservationReapplyOutcome,
  SourceObservationBulkJobAction,
  SourceObservationJobRunContext,
  SourceObservationIntegrationJobScope,
  SourceObservationIntegrationImportPreview,
  CatalogSyncRun,
  CatalogSyncRunDurableJobRecord,
  CatalogSyncRunChildJobLink,
  CatalogSyncRunSelectedUnitSnapshot,
  CatalogScopeSyncUnitStateReadModel,
  CatalogSyncRunChildJob,
  SourceObservationIntegrationJobAction,
  SourceObservationIntegrationDurableJobRecord,
  ProviderAdapterIntegrationImportTarget,
  ProviderIntegrationImportTargetOptionScope,
  SourceObservationIntegrationImportPreviewTarget,
  ProviderAdapterImportProgress,
} from "./source-observation-runtime-contracts";
import {
  scrydexOnePieceCredentialsFromEnv,
  recordBulkReviewWorkUnitTelemetry,
  recordBulkReviewControlPlaneTelemetry,
  recordIntegrationJobTelemetry,
  sourceObservationIntegrationJobTelemetryResult,
  recordIntegrationJobControlPlaneTelemetry,
  providerOptionAliasesToJson,
  listTcgdexLanguagesThroughAdapter,
  listTcgdexSeriesThroughAdapter,
  listTcgdexExpansionsThroughAdapter,
  queryProviderIntegrationOptions,
  listProviderIntegrationOptions,
  defaultSourceObservationImportProviderKeyFromVersions,
} from "./provider-option-queries";
import {
  notEvaluatedDuplicatePreventionPreview,
  duplicatePreventionCandidatePreview,
  normalizeReapplyProfileMode,
  loadSelectedOptionAuthoringSchema,
  loadPromotionTargetAuthoringSchema,
  buildCatalogIntegrationControlPlaneReadiness,
  isActiveSourceObservationImportProfileVersion,
  createCatalogIntegrationProfileVersionResolvers,
} from "./catalog-integration-control-plane-readiness";
import {
  toSourceObservationBulkJobEventSnapshot,
  toSourceObservationIntegrationJobEventSnapshot,
  toCatalogSyncRunFanoutEventSnapshot,
  normalizeOptionalKey,
  normalizeCandidateGenerationScope,
  profileSelectorFromScope,
  jobMatchesContext,
  toSourceObservationIntegrationJob,
  isImpactBlockingJob,
  impactJobProviderKey,
  toSourceObservationBulkJob,
  uniqueObservationIds,
  bulkProgress,
  runSourceObservationSideEffectImmediately,
  summarizePromotionOutcomes,
  summarizeReapplyOutcomes,
  normalizeBulkJobScope,
  isJobRunCancelled,
  toClaimedSourceObservationBulkJobFromWorkUnitClaim,
  throwIfJobRunCancelled,
  createSourceObservationWorkUnitSideEffectRunner,
  failedBulkWorkUnitOutcome,
  workUnitTerminalState,
  requireSourceObservationJobClaim,
  SourceObservationJobCancelledError,
  bulkResultOutcomes,
  isReapplyOutcome,
  isPromotionOutcome,
  parseJsonField,
  formatDateLike,
  normalizeIntegrationJobScope,
  selectedCatalogSyncRunUnits,
  catalogSyncRunIdempotencyKey,
  catalogSyncRunFanoutProgress,
  catalogScopeSyncStateDescriptor,
  compactStringRecord,
  recordFromUnknownStringRecord,
  catalogScopeSyncObservedStatusFromChildLink,
  childExecutionScopesMatch,
  catalogSyncRunChildStatus,
  catalogSyncRunProgress,
  catalogSyncRunOperatorStatus,
  reusableActiveIntegrationJobOperatorStatuses,
  integrationScopeToObservationScope,
  isDurableJobClaimExpired,
  integrationJobOperatorStatus,
  retryableIntegrationJobResult,
  isOperatorCancelledIntegrationJob,
  toClaimedSourceObservationIntegrationJob,
  integrationReapplyOutcomeFromBulkOutcome,
  summarizeIntegrationJobOutcomes,
  createSourceObservationSideEffectRunner,
  integrationImportPreviewTargetFromPlan,
  providerUsageEvidenceFromImportPlan,
  toSourceObservationJobEvent,
  terminalPromotionOutcomeFromEvents,
  sourceObservationRetentionCutoff,
} from "./source-observation-job-serialization";
import type { ClaimedSourceObservationIntegrationJob } from "./source-observation-job-serialization";
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

const PRINTED_CARD_COUNT_ATTRIBUTE = "printed-card-count";
const INTEGRATION_REAPPLY_JOB_BATCH_SIZE = 10;
const {
  requireCatalogImportProfileVersion,
  requireCatalogImportProfileVersionForJob,
  requireCatalogReapplyActiveProfileVersion,
  requireCatalogPromotionProfileVersionForReapply,
  requireReferenceDataPromotionProfileVersionForReapply,
  snapshotCatalogProfileVersion,
  snapshotCatalogReapplyProfileVersion,
  integrationProfileSnapshotKey,
  commonProfileSnapshot,
} = createCatalogIntegrationProfileVersionResolvers({
  defaultSourceObservationImportProviderKey,
  isActivePromotionProfileVersion,
  requireCatalogPromotionProfileVersion,
  requireReferenceDataPromotionProfileVersion,
  requireOriginalSourceProfileMarker,
  sourceMappingFingerprintForProfileVersion: (version) =>
    catalogProviderSourceMappingFingerprint(requireSourceObservationMappingContract(version)),
});

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
  const aliasPromotionServices = resolveAliasPromotionServices(deps, aliasPromotion);
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
    initialState: () => initialSourceObservationState,
    evolve: evolveSourceObservation,
    decide: decideSourceObservation,
  });
  const { commandHandler: catalogMergeCandidateCommandHandler, repository: catalogMergeCandidateRepository } =
    createAggregateCommandHandler({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>(),
      initialState: () => initialCatalogMergeCandidateState,
      evolve: evolveCatalogMergeCandidate,
      decide: decideCatalogMergeCandidate,
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

  async function recordObservation(observation: SourceObservationRecordInput, context: EventStoreContext) {
    await commandHandler({
      streamId: sourceObservationStreamId(observation.observationId),
      command: {
        type: "RecordSourceObservation",
        ...observation,
      },
      context,
    });
  }

  async function generateCatalogMergeCandidates(input: {
    syncRunId?: string | null;
    scope?: SourceObservationFilterScope;
    context: EventStoreContext;
  }): Promise<CatalogMergeCandidateGenerationResult> {
    const syncRunId = normalizeOptionalKey(input.syncRunId);
    const scope = normalizeCandidateGenerationScope(input.scope ?? {}, syncRunId);
    const observations = await listSourceObservationsForCandidateMatching(deps.db, scope);
    const generated = await persistCatalogMergeCandidatesFromObservations(observations, input.context);

    return {
      syncRunId,
      scope,
      observationCount: observations.length,
      matchedObservationCount: observations.length - generated.exclusions.length,
      excludedObservationCount: generated.exclusions.length,
      candidateCount: generated.candidates.length,
      candidates: generated.candidates,
      exclusions: generated.exclusions,
    };
  }

  async function persistCatalogMergeCandidatesFromObservations(
    observations: readonly SourceObservationListRow[],
    context: EventStoreContext,
  ): Promise<CatalogMergeCandidateMatchBatch> {
    const addedAt = new Date().toISOString();
    const providerKeys = [
      ...new Set(observations.map((observation) => observation.provider_key.trim().toLowerCase())),
    ].sort();
    const providerProfileVersions = (
      await Promise.all(providerKeys.map((providerKey) => profileVersions.listProfileVersions(providerKey)))
    ).flat();
    const unitKeyByProfileVersion = new Map(
      providerProfileVersions.map((version) => [
        catalogProviderProfileVersionLookupKey(version.providerKey, version.profileKey, version.profileVersion),
        unitKeyForCatalogProviderProfileVersion(version),
      ]),
    );
    const providerUnitKeyByObservationId = Object.fromEntries(
      observations.flatMap((observation) => {
        const unitKey = unitKeyByProfileVersion.get(
          catalogProviderProfileVersionLookupKey(
            observation.provider_key,
            observation.source_profile_key,
            observation.source_profile_version,
          ),
        );
        return unitKey ? [[observation.observation_id, unitKey]] : [];
      }),
    );
    const acceptedScopeMappings = await listAcceptedProviderScopeMappingsForProviders(deps.db, providerKeys);
    const generated = buildCatalogMergeCandidatesFromObservations(observations, {
      addedAt,
      acceptedScopeMappings,
      providerUnitKeyByObservationId,
    });

    for (const candidate of generated.candidates) {
      const streamId = catalogMergeCandidateStreamId(candidate.candidateId);
      const existingEvents = await deps.eventStore.readStream({ streamId });
      const now = new Date().toISOString();
      await catalogMergeCandidateCommandHandler({
        streamId,
        command:
          existingEvents.length > 0
            ? {
                type: "RefreshCatalogMergeCandidate",
                snapshot: candidate.snapshot,
                refreshedAt: now,
              }
            : {
                type: "CreateCatalogMergeCandidate",
                candidateId: candidate.candidateId,
                snapshot: candidate.snapshot,
                createdAt: now,
              },
        context,
      });
    }

    return generated;
  }

  function sourceObservationRecordToCandidateRow(observation: SourceObservationRecordInput): SourceObservationListRow {
    return {
      observation_id: observation.observationId,
      sync_run_id: observation.syncRunId?.trim() || null,
      provider_key: observation.providerKey,
      external_key: observation.externalKey,
      source_url: observation.sourceUrl,
      language_code: observation.languageCode,
      source_record_hash: observation.sourceRecordHash,
      source_updated_at: observation.sourceUpdatedAt ?? null,
      observed_at: observation.observedAt,
      source_profile_key: observation.sourceProfileKey,
      source_profile_version: observation.sourceProfileVersion,
      source_mapping_fingerprint: observation.sourceMappingFingerprint,
      normalized: observation.normalized,
      status: "observed",
      status_reason: null,
      promoted_catalog_item_id: null,
      promoted_reference_record_id: null,
      promoted_at: null,
      promotion_profile_key: null,
      promotion_profile_version: null,
      promotion_plan_fingerprint: null,
      updated_at: observation.observedAt,
    };
  }

  async function dispatchCatalogMergeCandidateCommand(input: {
    candidateId: string;
    action: CatalogMergeCandidateActionResult["action"];
    command: CatalogMergeCandidateCommand;
    context: EventStoreContext;
  }): Promise<CatalogMergeCandidateActionResult> {
    const result = await catalogMergeCandidateCommandHandler({
      streamId: catalogMergeCandidateStreamId(input.candidateId),
      command: input.command,
      context: input.context,
    });

    return {
      candidateId: input.candidateId,
      action: input.action,
      version: result.version,
      status: result.state.status,
      statusReason: result.state.statusReason,
      snapshot: result.state.snapshot,
    };
  }

  async function createSplitCatalogMergeCandidate(input: {
    candidateId: string;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    createdAt: string;
    context: EventStoreContext;
  }): Promise<NonNullable<CatalogMergeCandidateActionResult["splitCandidate"]>> {
    const result = await catalogMergeCandidateCommandHandler({
      streamId: catalogMergeCandidateStreamId(input.candidateId),
      command: {
        type: "CreateCatalogMergeCandidate",
        candidateId: input.candidateId,
        snapshot: input.snapshot,
        createdAt: input.createdAt,
      },
      context: input.context,
    });

    return {
      candidateId: input.candidateId,
      version: result.version,
      status: result.state.status,
      statusReason: result.state.statusReason,
      snapshot: result.state.snapshot,
    };
  }

  /**
   * Write the accepted-alias facts and retractions for a promoted/reapplied
   * observation. The Catalog Item id and Reference Record ids are
   * already resolved here, satisfying the rule that an item-level alias
   * resolves its `catalog_item_id` before a row is written. No-op when alias
   * promotion was not wired (minimal/legacy callers).
   */
  async function promoteAliasesForObservation(input: {
    observationId: string;
    catalogItemId: CatalogItemId;
    referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
    context: EventStoreContext;
  }): Promise<void> {
    if (!aliasPromotionServices) {
      return;
    }
    const resolution: PromotionAliasTargetResolution = {
      catalogItemId: input.catalogItemId,
      referenceRecordIdsByTypeKey: input.referenceRecordIdsByTypeKey,
    };
    await writePromotionAliases({
      services: aliasPromotionServices,
      observationId: input.observationId,
      resolution,
      context: input.context,
    });
  }

  async function previewDuplicatePreventionCandidates(input: {
    providerKey: string;
    profileVersion: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    payload: JsonValue;
    observedAt?: string;
  }): Promise<SourceObservationDuplicatePreventionCandidatePreview> {
    const version = getCatalogProviderIntegrationProfileVersion(
      input.providerKey,
      input.profileVersion,
      profileSelectorFromScope(input),
      await profileVersions.listProfileVersions(input.providerKey),
    );
    if (!version) {
      return notEvaluatedDuplicatePreventionPreview(
        `Catalog provider profile version ${input.providerKey}@${input.profileVersion} was not found.`,
      );
    }

    try {
      const contract = requireSourceObservationMappingContract(version);
      const normalization = normalizeCatalogProviderSourceObservation({
        contract,
        payload: input.payload,
        observedAt: input.observedAt ?? new Date(0).toISOString(),
      });
      if (!normalization.observation) {
        return notEvaluatedDuplicatePreventionPreview("Source Observation normalization did not complete.");
      }

      const normalized = requireCatalogItemPromotionObservation(
        normalization.observation.normalized,
        input.providerKey,
      );
      const catalogMapping = await loadCatalogItemPromotionProfile(deps, version.profile);
      const result = await resolveCatalogProviderDuplicatePrevention({
        db: deps.db,
        profile: version.profile,
        providerKey: input.providerKey,
        externalKey: normalization.observation.externalKey,
        normalized,
        catalog: {
          blueprintId: catalogMapping.blueprintId,
          categoryId: catalogMapping.categoryId,
          fieldIds: catalogMapping.fieldIds,
        },
      });

      return duplicatePreventionCandidatePreview(result);
    } catch (error) {
      return notEvaluatedDuplicatePreventionPreview(
        error instanceof Error ? error.message : "Duplicate-prevention candidate preview failed.",
      );
    }
  }

  async function previewReplayReapplyImpact(input: {
    providerKey: string;
    profileVersion: string;
    scope: SourceObservationFilterScope;
    context?: EventStoreContext | null;
  }): Promise<CatalogAdminReplayReapplyImpactSummaryReadModel> {
    const version = await requireCatalogImpactProfileVersion(input.providerKey, input.profileVersion);
    const impact = await summarizeSourceObservationReplayImpact(deps.db, {
      ...input.scope,
      provider: input.providerKey,
    });
    const activeJobs = await listCatalogIntegrationImpactActiveJobs({
      providerKey: input.providerKey,
      profileVersion: input.profileVersion,
      context: input.context ?? null,
    });

    return buildCatalogReplayReapplyImpactReadModel({
      unitKey: unitKeyForCatalogProviderProfileVersion(version),
      profile: toCatalogAdminProfileVersionPointer(version),
      impact,
      activeJobs,
    });
  }

  async function previewProviderProfileLifecycleImpact(input: {
    providerKey: string;
    profileVersion: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    operation: CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];
    context?: EventStoreContext | null;
  }): Promise<CatalogAdminRollbackRetirementImpactSummaryReadModel> {
    const version = await requireCatalogImpactProfileVersion(
      input.providerKey,
      input.profileVersion,
      profileSelectorFromScope(input),
    );
    const [impact, activeJobs] = await Promise.all([
      summarizeSourceObservationLifecycleImpact(deps.db, {
        providerKey: input.providerKey,
        profileVersion: input.profileVersion,
        operation: input.operation,
      }),
      listCatalogIntegrationImpactActiveJobs({
        providerKey: input.providerKey,
        profileVersion: input.profileVersion,
        context: input.context ?? null,
      }),
    ]);

    return buildCatalogLifecycleImpactReadModel({
      unitKey: unitKeyForCatalogProviderProfileVersion(version),
      profile: toCatalogAdminProfileVersionPointer(version),
      operation: input.operation,
      impact,
      activeJobs,
    });
  }

  async function requireCatalogImpactProfileVersion(
    providerKey: string,
    profileVersion: string,
    selector?: CatalogProviderProfileVersionSelector | null,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    const version = getCatalogProviderIntegrationProfileVersion(
      providerKey,
      profileVersion,
      selector,
      await profileVersions.listProfileVersions(providerKey),
    );
    if (!version) {
      throw new Error(`Catalog provider profile version ${providerKey}@${profileVersion} was not found.`);
    }

    return version;
  }

  async function listCatalogIntegrationImpactActiveJobs(input: {
    providerKey: string;
    profileVersion: string;
    context: EventStoreContext | null;
  }): Promise<readonly CatalogIntegrationImpactJobSample[]> {
    const [integrationJobs, bulkJobs] = await Promise.all([
      integrationJobStore.listActive({ jobKinds: ["import", "reapply"] }),
      bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "reapply"] }),
    ]);
    const providerKey = input.providerKey.trim().toLowerCase();

    return [
      ...integrationJobs
        .filter((job) => !input.context || jobMatchesContext(job, input.context))
        .map(toSourceObservationIntegrationJob)
        .filter((job) => isImpactBlockingJob(job.status, job.action))
        .filter((job) => impactJobProviderKey(job)?.trim().toLowerCase() === providerKey)
        .map((job) => ({
          jobId: job.jobId,
          jobKind: "integration" as const,
          action: job.action,
          status: job.status,
          providerKey: impactJobProviderKey(job),
          profileVersion: job.profileSnapshot?.profileVersion ?? null,
        })),
      ...bulkJobs
        .filter((job) => !input.context || jobMatchesContext(job, input.context))
        .map(toSourceObservationBulkJob)
        .filter((job) => isImpactBlockingJob(job.status, job.action))
        .filter((job) => {
          const jobProviderKey = job.scope.provider?.trim().toLowerCase() ?? null;
          return !jobProviderKey || jobProviderKey === providerKey;
        })
        .map((job) => ({
          jobId: job.jobId,
          jobKind: "bulk-review" as const,
          action: job.action,
          status: job.status,
          providerKey: job.scope.provider ?? null,
          profileVersion: null,
        })),
    ];
  }

  async function promoteObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    if (
      isMagicSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isLorcanaSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isOnePieceSetReferenceSourceObservationNormalized(input.observation.normalized)
    ) {
      return promoteReferenceObservationFromRow({
        ...input,
        normalized: input.observation.normalized,
      });
    }

    return promoteCatalogItemObservationFromRow(input);
  }

  async function promoteCatalogItemObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  }): Promise<SourceObservationPromotionTargetResult & SourceObservationPromotionProfileEvidence> {
    const normalized = requireCatalogItemPromotionObservation(
      input.observation.normalized,
      input.observation.provider_key,
    );
    const providerProfileVersion = await requireCatalogPromotionProfileVersion(
      profileVersions,
      input.observation.provider_key,
      normalized,
    );
    const providerProfile = providerProfileVersion.profile;
    requirePromotionAssetPorts({ deps, normalized, productAssetSource: input.productAssetSource });

    const existingCatalogItemId =
      input.observation.status === "changed" || input.observation.status === "promoted"
        ? (input.observation.promoted_catalog_item_id as CatalogItemId | null)
        : null;
    if ((input.observation.status === "changed" || input.observation.status === "promoted") && !existingCatalogItemId) {
      throw new Error(
        `${capitalize(input.observation.status)} source observation is missing its promoted Catalog Item.`,
      );
    }

    const catalogMapping = await loadCatalogItemPromotionProfile(deps, providerProfile);
    const duplicatePreventionResult = !existingCatalogItemId
      ? await resolveCatalogProviderDuplicatePrevention({
          db: deps.db,
          profile: providerProfile,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          normalized,
          catalog: {
            blueprintId: catalogMapping.blueprintId,
            categoryId: catalogMapping.categoryId,
            fieldIds: catalogMapping.fieldIds,
          },
        })
      : null;
    if (duplicatePreventionResult?.status === "blocked") {
      throw new Error(duplicatePreventionResult.diagnosticText);
    }
    const reusableCatalogItemId =
      existingCatalogItemId ??
      (duplicatePreventionResult?.status === "matched" ? duplicatePreventionResult.catalogItemId : null);
    const catalogItemId = reusableCatalogItemId ?? (createId("cat") as CatalogItemId);

    const { referenceRecordIdsByTypeKey, ...promotionEvidence } = reusableCatalogItemId
      ? await refreshCatalogItemFromObservation({
          items,
          referenceData,
          productContents,
          deps,
          catalogItemId: reusableCatalogItemId,
          normalized,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          providerProfile,
          providerProfileVersion,
          catalogMapping,
          sourceUpdatedAt: input.observation.source_updated_at,
          observedAt: input.observation.observed_at,
          productAssetSource: input.productAssetSource,
          context: input.context,
        })
      : await createCatalogDraftFromObservation({
          items,
          referenceData,
          productContents,
          deps,
          catalogItemId,
          normalized,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          providerProfile,
          providerProfileVersion,
          catalogMapping,
          sourceUpdatedAt: input.observation.source_updated_at,
          observedAt: input.observation.observed_at,
          productAssetSource: input.productAssetSource,
          context: input.context,
        });

    await promoteAliasesForObservation({
      observationId: input.observation.observation_id,
      catalogItemId,
      referenceRecordIdsByTypeKey,
      context: input.context,
    });

    if (input.observation.status !== "promoted") {
      const promotedAt = new Date().toISOString();
      await commandHandler({
        streamId: sourceObservationStreamId(input.observation.observation_id),
        command: {
          type: "PromoteSourceObservation",
          catalogItemId,
          promotedAt,
          ...promotionEvidence,
        },
        context: input.context,
      });
    }

    return {
      observationId: input.observation.observation_id,
      catalogItemId,
      ...promotionEvidence,
    };
  }

  async function promoteReferenceObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized;
    context: EventStoreContext;
  }): Promise<SourceObservationPromotionTargetResult> {
    const providerProfileVersion = await requireReferenceDataPromotionProfileVersion(
      profileVersions,
      input.observation.provider_key,
      input.normalized,
    );
    const { targetReferenceRecordId } = await resolveReferenceDataPromotionHierarchy({
      deps,
      referenceData,
      profile: providerProfileVersion.profile,
      normalized: input.normalized,
      context: input.context,
    });
    const promotionEvidence = referenceDataPromotionEvidence({
      providerProfileVersion,
      normalized: input.normalized,
      referenceRecordId: targetReferenceRecordId,
    });

    if (input.observation.status !== "promoted") {
      await commandHandler({
        streamId: sourceObservationStreamId(input.observation.observation_id),
        command: {
          type: "PromoteSourceObservationReference",
          referenceRecordId: targetReferenceRecordId,
          promotedAt: new Date().toISOString(),
          ...promotionEvidence,
        },
        context: input.context,
      });
    }

    return {
      observationId: input.observation.observation_id,
      catalogItemId: null,
      referenceRecordId: targetReferenceRecordId,
    };
  }

  async function promoteObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runPromoteObservation?: DurableSideEffectRunner;
  }): Promise<BulkSourceObservationPromotionResult> {
    rolloutControlPolicy.assertAllowed({ capability: "promotion" });
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }
        rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: observation.provider_key });

        if (!isPromotableObservationStatus(observation.status)) {
          const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
          outcomes.push(
            recovered ?? {
              observationId,
              status: "skipped",
              catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
              referenceRecordId: observation.promoted_reference_record_id as ReferenceRecordId | null,
              reason: `Source observation is ${observation.status}.`,
            },
          );
          continue;
        }

        const promoted = await (input.runPromoteObservation ?? runSourceObservationSideEffectImmediately)(() =>
          promoteObservationFromRow({
            observation,
            context: input.context,
          }),
        );
        outcomes.push({
          observationId,
          status: "promoted",
          catalogItemId: promoted.catalogItemId,
          referenceRecordId: promoted.referenceRecordId,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
        outcomes.push(
          recovered ?? {
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: error instanceof Error ? error.message : "Promotion failed.",
          },
        );
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  async function recoverAlreadyPromotedObservationOutcome(
    observationId: string,
  ): Promise<BulkSourceObservationPromotionOutcome | null> {
    const latestObservation = await getSourceObservationDetail(deps.db, observationId);
    if (latestObservation?.status !== "promoted") {
      return null;
    }
    const catalogItemId = latestObservation.promoted_catalog_item_id as CatalogItemId | null;
    const referenceRecordId = latestObservation.promoted_reference_record_id as ReferenceRecordId | null;
    if (!catalogItemId && !referenceRecordId) {
      return null;
    }

    return {
      observationId,
      status: "promoted",
      catalogItemId,
      referenceRecordId,
      reason: null,
    };
  }

  async function reapplyObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    if (
      isMagicSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isLorcanaSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isOnePieceSetReferenceSourceObservationNormalized(input.observation.normalized)
    ) {
      return reapplyReferenceObservationFromRow({
        ...input,
        normalized: input.observation.normalized,
      });
    }

    return reapplyCatalogItemObservationFromRow(input);
  }

  async function reapplyCatalogItemObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    const normalized = requireCatalogItemPromotionObservation(
      input.observation.normalized,
      input.observation.provider_key,
    );
    const providerProfileVersion = await requireCatalogPromotionProfileVersionForReapply(
      profileVersions,
      input.observation,
      normalized,
      input.reapplyProfileMode,
      input.profileSnapshot ?? null,
    );
    const providerProfile = providerProfileVersion.profile;
    requirePromotionAssetPorts({ deps, normalized });

    if (input.observation.status !== "promoted") {
      throw new Error("Only promoted source observations can be reapplied.");
    }

    const catalogItemId = input.observation.promoted_catalog_item_id as CatalogItemId | null;
    if (!catalogItemId) {
      throw new Error("Promoted source observation is missing its Catalog Item.");
    }

    const { referenceRecordIdsByTypeKey, ...promotionEvidence } = await refreshCatalogItemFromObservation({
      items,
      referenceData,
      productContents,
      deps,
      catalogItemId,
      normalized,
      providerKey: input.observation.provider_key,
      externalKey: input.observation.external_key,
      providerProfile,
      providerProfileVersion,
      catalogMapping: await loadCatalogItemPromotionProfile(deps, providerProfile),
      sourceUpdatedAt: input.observation.source_updated_at,
      observedAt: input.observation.observed_at,
      context: input.context,
    });

    await promoteAliasesForObservation({
      observationId: input.observation.observation_id,
      catalogItemId,
      referenceRecordIdsByTypeKey,
      context: input.context,
    });

    await commandHandler({
      streamId: sourceObservationStreamId(input.observation.observation_id),
      command: {
        type: "RecordSourceObservationPromotionPlan",
        catalogItemId,
        ...promotionEvidence,
      },
      context: input.context,
    });

    return {
      observationId: input.observation.observation_id,
      catalogItemId,
    };
  }

  async function reapplyReferenceObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized;
    context: EventStoreContext;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    const providerProfileVersion = await requireReferenceDataPromotionProfileVersionForReapply(
      profileVersions,
      input.observation,
      input.normalized,
      input.reapplyProfileMode,
      input.profileSnapshot ?? null,
    );

    if (input.observation.status !== "promoted") {
      throw new Error("Only promoted source observations can be reapplied.");
    }

    const { targetReferenceRecordId } = await resolveReferenceDataPromotionHierarchy({
      deps,
      referenceData,
      profile: providerProfileVersion.profile,
      normalized: input.normalized,
      context: input.context,
    });
    const promotionEvidence = referenceDataPromotionEvidence({
      providerProfileVersion,
      normalized: input.normalized,
      referenceRecordId: targetReferenceRecordId,
    });

    await commandHandler({
      streamId: sourceObservationStreamId(input.observation.observation_id),
      command: {
        type: "RecordSourceObservationReferencePromotionPlan",
        referenceRecordId: targetReferenceRecordId,
        ...promotionEvidence,
      },
      context: input.context,
    });

    return {
      observationId: input.observation.observation_id,
      catalogItemId: null,
      referenceRecordId: targetReferenceRecordId,
    };
  }

  async function reapplyObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runReapplyObservation?: DurableSideEffectRunner;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<BulkSourceObservationReapplyResult> {
    rolloutControlPolicy.assertAllowed({ capability: "reapply" });
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationReapplyOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }
        rolloutControlPolicy.assertAllowed({ capability: "reapply", providerKey: observation.provider_key });

        if (observation.status !== "promoted") {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            referenceRecordId: observation.promoted_reference_record_id as ReferenceRecordId | null,
            reason: `Source observation is ${observation.status}.`,
          });
          continue;
        }

        const reapplied = await (input.runReapplyObservation ?? runSourceObservationSideEffectImmediately)(() =>
          reapplyObservationFromRow({
            observation,
            context: input.context,
            reapplyProfileMode: input.reapplyProfileMode,
            profileSnapshot: input.profileSnapshot,
          }),
        );
        outcomes.push({
          observationId,
          status: "reapplied",
          catalogItemId: reapplied.catalogItemId,
          referenceRecordId: reapplied.referenceRecordId,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Reapply failed.",
        });
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizeReapplyOutcomes(requestedIds.length, outcomes);
  }

  async function rejectObservationIds(input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runRejectObservation?: DurableSideEffectRunner;
  }): Promise<BulkSourceObservationPromotionResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }

        if (observation.status !== "observed") {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            reason: `Source observation is already ${observation.status}.`,
          });
          continue;
        }

        await (input.runRejectObservation ?? runSourceObservationSideEffectImmediately)(() =>
          commandHandler({
            streamId: sourceObservationStreamId(observationId),
            command: {
              type: "RejectSourceObservation",
              reason: input.reason,
            },
            context: input.context,
          }),
        );
        outcomes.push({
          observationId,
          status: "rejected",
          catalogItemId: null,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Rejection failed.",
        });
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  async function deferObservationIds(input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runDeferObservation?: DurableSideEffectRunner;
  }): Promise<BulkSourceObservationPromotionResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }

        if (!isReviewableObservationStatus(observation.status)) {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            reason: `Source observation is ${observation.status}.`,
          });
          continue;
        }

        await (input.runDeferObservation ?? runSourceObservationSideEffectImmediately)(() =>
          commandHandler({
            streamId: sourceObservationStreamId(observationId),
            command: {
              type: "DeferSourceObservation",
              reason: input.reason,
              deferredAt: new Date().toISOString(),
            },
            context: input.context,
          }),
        );
        outcomes.push({
          observationId,
          status: "deferred",
          catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Deferral failed.",
        });
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  async function enqueueBulkReviewJob(input: {
    action: SourceObservationBulkJobAction;
    observationIds?: readonly string[];
    scope?: SourceObservationFilterScope;
    reason?: string | null;
    reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
    context: EventStoreContext;
  }): Promise<SourceObservationBulkJob> {
    if (input.action === "promote") {
      rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: input.scope?.provider });
    }
    if (input.action === "reapply") {
      rolloutControlPolicy.assertAllowed({ capability: "reapply", providerKey: input.scope?.provider });
    }
    const observationIds = uniqueObservationIds(input.observationIds ?? []);
    const selectionMode = observationIds.length > 0 ? "ids" : "filter";
    const scope = selectionMode === "filter" ? normalizeBulkJobScope(input.scope ?? {}) : {};
    const reapplyProfileMode =
      input.action === "reapply"
        ? (normalizeReapplyProfileMode(input.reapplyProfileMode) ?? "current-active-profile")
        : null;
    const jobId = createId("job");
    const unitObservationIds =
      selectionMode === "ids" ? observationIds : await listSourceObservationIdsForBulkAction(input.action, scope);
    const unitProfileSnapshots =
      input.action === "reapply" && reapplyProfileMode === "current-active-profile" && selectionMode === "ids"
        ? await snapshotSelectedReapplyProfiles(unitObservationIds)
        : new Map<string, SourceObservationIntegrationProfileSnapshot | null>();
    const profileSnapshot =
      input.action === "reapply" && reapplyProfileMode === "current-active-profile"
        ? selectionMode === "ids"
          ? commonProfileSnapshot([...unitProfileSnapshots.values()])
          : snapshotCatalogReapplyProfileVersion(
              await requireCatalogReapplyActiveProfileVersion(profileVersions, scope.provider, null),
            )
        : null;
    const progress = bulkProgress(0, unitObservationIds.length, null, null, "queued");
    const job = await bulkReviewJobStore.enqueue({
      jobId,
      jobKind: input.action,
      payload: {
        action: input.action,
        selectionMode,
        observationIds,
        scope,
        reason: input.reason?.trim() || null,
        profileSnapshot,
        reapplyProfileMode,
      },
      progress,
      eventContext: input.context,
    });
    await bulkReviewWorkUnitStore.enqueue({
      jobId,
      units: unitObservationIds.map((observationId) => ({
        unitId: observationId,
        unitKind: input.action,
        payload: {
          observationId,
          profileSnapshot: unitProfileSnapshots.get(observationId) ?? profileSnapshot,
          reapplyProfileMode,
        },
      })),
    });

    return toSourceObservationBulkJob(job);
  }

  async function snapshotSelectedReapplyProfiles(
    observationIds: readonly string[],
  ): Promise<Map<string, SourceObservationIntegrationProfileSnapshot | null>> {
    const snapshots = new Map<string, SourceObservationIntegrationProfileSnapshot | null>();
    const profilesByProvider = new Map<string, SourceObservationIntegrationProfileSnapshot>();

    for (const observationId of observationIds) {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation) {
        snapshots.set(observationId, null);
        continue;
      }

      const providerKey = observation.provider_key.trim().toLowerCase();
      const cacheKey = `${providerKey}:${observation.normalized.kind}`;
      let snapshot = profilesByProvider.get(cacheKey);
      if (!snapshot) {
        snapshot = snapshotCatalogReapplyProfileVersion(
          await requireCatalogPromotionProfileVersion(profileVersions, providerKey, observation.normalized),
        );
        profilesByProvider.set(cacheKey, snapshot);
      }
      snapshots.set(observationId, snapshot);
    }

    return snapshots;
  }

  async function processNextBulkReviewJob(
    input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
    } & SourceObservationJobRunContext,
  ): Promise<number> {
    if (isJobRunCancelled(input)) {
      return 0;
    }

    const claimResult = await bulkReviewWorkUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["promote", "reject", "defer", "reapply"],
      laneName: input.laneName ?? null,
    });
    if (!claimResult.claim) {
      const reconciled = await reconcileTerminalBulkReviewJobs();
      return reconciled > 0 ? reconciled : 0;
    }
    const claim = claimResult.claim;
    const claimed = toClaimedSourceObservationBulkJobFromWorkUnitClaim(claim);

    try {
      throwIfJobRunCancelled(input);
      const runBulkReviewSideEffect = createSourceObservationWorkUnitSideEffectRunner(bulkReviewWorkUnitStore, claim, {
        signal: input.signal,
        throwIfLeaseLost: input.throwIfLeaseLost,
        claimTtlMs: input.claimTtlMs,
      });
      const context = claimed.eventContext;

      const observationId = claim.unit.payload.observationId;
      const itemResult =
        claimed.action === "reapply"
          ? await reapplyObservationIds({
              observationIds: [observationId],
              context,
              runReapplyObservation: runBulkReviewSideEffect,
              reapplyProfileMode: requireBulkJobReapplyProfileMode(
                claim.unit.payload.reapplyProfileMode ?? claimed.reapplyProfileMode,
                claimed.jobId,
              ),
              profileSnapshot: claim.unit.payload.profileSnapshot ?? claimed.profileSnapshot,
            })
          : claimed.action === "promote"
            ? await promoteObservationIds({
                observationIds: [observationId],
                context,
                runPromoteObservation: runBulkReviewSideEffect,
              })
            : claimed.action === "defer"
              ? await deferObservationIds({
                  observationIds: [observationId],
                  reason: claimed.reason ?? "Deferred during review.",
                  context,
                  runDeferObservation: runBulkReviewSideEffect,
                })
              : await rejectObservationIds({
                  observationIds: [observationId],
                  reason: claimed.reason ?? "Rejected during review.",
                  context,
                  runRejectObservation: runBulkReviewSideEffect,
                });
      const outcome = itemResult.outcomes[0] ?? failedBulkWorkUnitOutcome(claimed.action, observationId, "No outcome.");
      const terminalState = workUnitTerminalState(outcome);
      throwIfJobRunCancelled(input);

      await requireSourceObservationJobClaim(
        bulkReviewWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: terminalState,
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: claimed.progress,
          parentResult: claimed.result,
          resolveParentUpdate: (queryable) => bulkReviewParentUpdateFromWorkUnits(queryable, claimed),
        }),
      );
      recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, claimed.action, terminalState);
      recordBulkReviewControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, outcome);
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        await bulkReviewWorkUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        recordBulkReviewWorkUnitTelemetry(
          deps.sourceObservationTelemetry,
          claimed.action,
          error instanceof SourceObservationJobCancelledError ? "cancelled" : "released",
        );
        return 0;
      }

      const outcome = failedBulkWorkUnitOutcome(
        claimed.action,
        claim.unit.payload.observationId,
        error instanceof Error ? error.message : "Bulk review job failed.",
      );
      await requireSourceObservationJobClaim(
        bulkReviewWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: { ...claimed.progress, phase: "processing" },
          parentResult: claimed.result,
          resolveParentUpdate: (queryable) => bulkReviewParentUpdateFromWorkUnits(queryable, claimed),
        }),
      );
      recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, claimed.action, "failed");
      recordBulkReviewControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, outcome);
      return 1;
    }
  }

  async function reconcileTerminalBulkReviewJobs(): Promise<number> {
    const activeJobs = await bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "defer", "reapply"] });
    let reconciled = 0;
    for (const rawJob of activeJobs) {
      const summary = await bulkReviewWorkUnitStore.summarize({ jobId: rawJob.jobId });
      if (summary.queued > 0 || summary.running > 0 || summary.expiredClaims > 0) {
        continue;
      }

      const job = toSourceObservationBulkJob(rawJob);
      const parentUpdate = await bulkReviewParentUpdateFromWorkUnits(deps.db, job);
      if (!parentUpdate.completeJob) {
        continue;
      }

      const completed = await bulkReviewWorkUnitStore.reconcileTerminalParent({
        jobId: job.jobId,
        parentProgress: parentUpdate.parentProgress,
        parentResult: parentUpdate.parentResult,
        completeJob: true,
        resolveParentUpdate: (queryable) => bulkReviewParentUpdateFromWorkUnits(queryable, job),
      });
      if (completed) {
        reconciled += 1;
        recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, job.action, "reconciled");
      }
    }

    return reconciled;
  }

  async function listSourceObservationIdsForBulkAction(
    action: SourceObservationBulkJobAction,
    scope: SourceObservationFilterScope,
  ): Promise<readonly string[]> {
    return action === "reapply"
      ? listSourceObservationIdsForReapply(deps.db, scope)
      : listSourceObservationIdsForPromotion(deps.db, scope);
  }

  async function bulkReviewParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: SourceObservationBulkJob,
  ): Promise<
    Readonly<{
      parentProgress: BulkSourceObservationProgress;
      parentResult: SourceObservationBulkJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await listBulkReviewWorkUnitsForJob(queryable, job.jobId);
    const unitIds = new Set(units.map((unit) => unit.unitId));
    const carriedOutcomes = bulkResultOutcomes(job.result).filter((outcome) => !unitIds.has(outcome.observationId));
    const unitOutcomes = units
      .filter((unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped")
      .flatMap((unit) => (unit.result ? [unit.result] : []));
    const outcomes = [...carriedOutcomes, ...unitOutcomes];
    const allUnitsTerminal = units.every(
      (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
    );
    const resolvedTotal = Math.max(carriedOutcomes.length + units.length, outcomes.length);
    const total = allUnitsTerminal ? resolvedTotal : Math.max(job.progress.total, resolvedTotal);
    const completeJob = outcomes.length >= total && allUnitsTerminal;
    const latestOutcome = outcomes[outcomes.length - 1] ?? null;
    const parentProgress = bulkProgress(
      outcomes.length,
      total,
      null,
      latestOutcome?.status ?? null,
      completeJob ? "completed" : "processing",
    );
    const parentResult =
      job.action === "reapply"
        ? summarizeReapplyOutcomes(total, outcomes.filter(isReapplyOutcome))
        : summarizePromotionOutcomes(total, outcomes.filter(isPromotionOutcome));

    return { parentProgress, parentResult, completeJob };
  }

  async function listBulkReviewWorkUnitsForJob(
    queryable: PgQueryable,
    jobId: string,
  ): Promise<
    readonly DurableJobWorkUnitRecord<SourceObservationBulkWorkUnitPayload, SourceObservationBulkWorkUnitResult>[]
  > {
    const result = await queryable.query<{
      unit_id: string;
      unit_kind: string;
      state: "queued" | "running" | "completed" | "failed" | "skipped";
      payload: unknown;
      result: unknown;
      error_message: string | null;
      claim_owner_id: string | null;
      claim_token: string | null;
      claimed_until: Date | string | null;
      attempt_count: number | string;
      created_at: Date | string;
      updated_at: Date | string;
      completed_at: Date | string | null;
    }>(
      `SELECT unit_id,
              unit_kind,
              state,
              payload,
              result,
              error_message,
              claim_owner_id,
              claim_token,
              claimed_until,
              attempt_count,
              created_at,
              updated_at,
              completed_at
       FROM catalog_source_observation_bulk_review_work_units
       WHERE job_id = $1
       ORDER BY created_at ASC, unit_id ASC`,
      [jobId],
    );

    return result.rows.map((row) => ({
      jobId,
      unitId: row.unit_id,
      unitKind: row.unit_kind,
      state: row.state,
      payload: parseJsonField(row.payload, "work unit payload"),
      result: row.result == null ? null : parseJsonField(row.result, "work unit result"),
      errorMessage: row.error_message,
      claimOwnerId: row.claim_owner_id,
      claimToken: row.claim_token,
      claimedUntil: row.claimed_until == null ? null : formatDateLike(row.claimed_until),
      attemptCount: Number(row.attempt_count),
      createdAt: formatDateLike(row.created_at),
      updatedAt: formatDateLike(row.updated_at),
      completedAt: row.completed_at == null ? null : formatDateLike(row.completed_at),
    }));
  }

  async function listIntegrationWorkUnitsForJob(
    queryable: PgQueryable,
    jobId: string,
  ): Promise<
    readonly DurableJobWorkUnitRecord<
      SourceObservationIntegrationWorkUnitPayload,
      SourceObservationIntegrationJobOutcome
    >[]
  > {
    const result = await queryable.query<{
      unit_id: string;
      unit_kind: string;
      state: "queued" | "running" | "completed" | "failed" | "skipped";
      payload: unknown;
      result: unknown;
      error_message: string | null;
      claim_owner_id: string | null;
      claim_token: string | null;
      claimed_until: Date | string | null;
      attempt_count: number | string;
      created_at: Date | string;
      updated_at: Date | string;
      completed_at: Date | string | null;
    }>(
      `SELECT unit_id,
              unit_kind,
              state,
              payload,
              result,
              error_message,
              claim_owner_id,
              claim_token,
              claimed_until,
              attempt_count,
              created_at,
              updated_at,
              completed_at
       FROM catalog_source_observation_integration_work_units
       WHERE job_id = $1
       ORDER BY created_at ASC, unit_id ASC`,
      [jobId],
    );

    return result.rows.map((row) => ({
      jobId,
      unitId: row.unit_id,
      unitKind: row.unit_kind,
      state: row.state,
      payload: parseJsonField(row.payload, "integration work unit payload"),
      result: row.result == null ? null : parseJsonField(row.result, "integration work unit result"),
      errorMessage: row.error_message,
      claimOwnerId: row.claim_owner_id,
      claimToken: row.claim_token,
      claimedUntil: row.claimed_until == null ? null : formatDateLike(row.claimed_until),
      attemptCount: Number(row.attempt_count),
      createdAt: formatDateLike(row.created_at),
      updatedAt: formatDateLike(row.updated_at),
      completedAt: row.completed_at == null ? null : formatDateLike(row.completed_at),
    }));
  }

  async function previewIntegrationImport(input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationImportPreview> {
    const scope = normalizeIntegrationJobScope(input.scope);
    rolloutControlPolicy.assertAllowed({ capability: "import", providerKey: scope.provider });
    rolloutControlPolicy.assertAllowed({ capability: "provider-transport", providerKey: scope.provider });
    const providerProfileVersion = await requireCatalogImportProfileVersion(
      profileVersions,
      scope.provider,
      profileSelectorFromScope(scope),
    );
    const providerProfile = providerProfileVersion.profile;

    const targets = await previewProviderAdapterIntegrationImportTargets(scope, providerProfileVersion);

    return {
      action: "import",
      providerKey: providerProfile.providerKey,
      scope,
      profileSnapshot: snapshotCatalogProfileVersion(providerProfileVersion),
      targetCount: targets.length,
      targets,
    };
  }

  async function previewCatalogSyncScope(input: {
    scope: CatalogSyncScope;
    context: EventStoreContext;
    includeOperationalGates?: boolean;
    acceptedScopeMappings?: readonly CatalogSyncAcceptedScopeMapping[];
  }): Promise<CatalogSyncProviderParticipationPreview> {
    void input.context;
    const versions = await profileVersions.listProfileVersions();
    // Provider coordinates are resolved from the scope record's accepted
    // Provider Scope Mappings. The scope-sync batch planner has already loaded
    // them and passes them through; the interactive path resolves them here.
    const acceptedScopeMappings =
      input.acceptedScopeMappings ?? (await resolveAcceptedScopeMappingsForScope(input.scope));
    return previewCatalogSyncProviderParticipation({
      scope: input.scope,
      acceptedScopeMappings,
      providerProfileVersions: versions,
      providerAdapterRegistry,
      rolloutControlPolicy,
      includeOperationalGates: input.includeOperationalGates,
    });
  }

  async function resolveAcceptedScopeMappingsForScope(
    scope: CatalogSyncScope,
  ): Promise<readonly CatalogSyncAcceptedScopeMapping[]> {
    const scopeRecordId = scope.reference.scopeRecordId?.trim();
    if (!scopeRecordId) {
      return [];
    }
    const rows = await listAcceptedProviderScopeMappingsByScopeRecord(deps.db, scopeRecordId);
    return rows.map(catalogSyncAcceptedScopeMappingFromRow);
  }

  async function enqueueCatalogSyncRun(input: {
    scope: CatalogSyncScope;
    context: EventStoreContext;
  }): Promise<CatalogSyncRun> {
    const preview = await previewCatalogSyncScope(input);
    if (!preview.startAllowed) {
      throw new Error(
        `Catalog sync scope is not ready to start: ${
          preview.blockers[0]?.message ?? "Required provider units are blocked."
        }`,
      );
    }

    const selectedUnits = selectedCatalogSyncRunUnits(preview);
    if (selectedUnits.length === 0) {
      throw new Error("Catalog sync scope has no selected eligible provider units.");
    }

    const idempotencyKey = catalogSyncRunIdempotencyKey(input.context, preview.scope, selectedUnits);
    const existingRun = await findReusableCatalogSyncRun(idempotencyKey, input.context);
    if (existingRun) {
      return existingRun;
    }

    const syncRunId = createId("job");
    let parentRecord: CatalogSyncRunDurableJobRecord;
    try {
      parentRecord = await catalogSyncRunStore.enqueue({
        jobId: syncRunId,
        jobKind: "catalog-sync-scope",
        payload: {
          runVersion: "catalog-sync-run-v1",
          idempotencyKey,
          scope: preview.scope,
          selectedUnits,
          preview,
        },
        progress: catalogSyncRunFanoutProgress(0, selectedUnits.length, null, null, "processing"),
        eventContext: input.context,
      });
    } catch (error) {
      const racedRun = await findReusableCatalogSyncRun(idempotencyKey, input.context);
      if (racedRun) {
        return racedRun;
      }
      throw error;
    }

    // Idempotent re-sync converges: a unit whose durable scope-state already
    // shows "settled" for this exact child execution scope is fast-forwarded
    // onto its prior completed job instead of enqueuing a new provider call.
    // When every selected unit fast-forwards, the whole "Sync scope" action
    // is a no-op sync run that completes immediately without touching any
    // provider — the settled-scope re-run acceptance criterion.
    const scopeKey = computeCatalogSyncScopeKey(catalogScopeSyncStateDescriptor(preview.scope));
    const childJobs: CatalogSyncRunChildJobLink[] = [];
    for (const unit of selectedUnits) {
      const fastForwardJobId = await resolveCatalogScopeSyncFastForwardJobId(scopeKey, unit);
      if (fastForwardJobId) {
        childJobs.push({
          providerKey: unit.providerKey,
          unitKey: unit.unitKey,
          profileKey: unit.profileKey,
          profileVersion: unit.profileVersion,
          displayName: unit.displayName,
          childExecutionScope: unit.childExecutionScope,
          childJobId: fastForwardJobId,
          syncRunLinkState: "reused-settled-child-job",
          errorMessage: null,
        });
        continue;
      }

      try {
        const childJob = await enqueueIntegrationJob({
          action: "import",
          scope: unit.childExecutionScope,
          syncRunId,
          context: input.context,
        });
        childJobs.push({
          providerKey: unit.providerKey,
          unitKey: unit.unitKey,
          profileKey: unit.profileKey,
          profileVersion: unit.profileVersion,
          displayName: unit.displayName,
          childExecutionScope: unit.childExecutionScope,
          childJobId: childJob.jobId,
          syncRunLinkState: childJob.syncRunId === syncRunId ? "attached-to-child-payload" : "reused-active-child-job",
          errorMessage: null,
        });
      } catch (error) {
        childJobs.push({
          providerKey: unit.providerKey,
          unitKey: unit.unitKey,
          profileKey: unit.profileKey,
          profileVersion: unit.profileVersion,
          displayName: unit.displayName,
          childExecutionScope: unit.childExecutionScope,
          childJobId: null,
          syncRunLinkState: "child-enqueue-failed",
          errorMessage: error instanceof Error ? error.message : "Provider child job could not be enqueued.",
        });
      }
    }

    parentRecord = await completeCatalogSyncRunFanout(parentRecord, childJobs);
    const run = await toCatalogSyncRun(parentRecord);
    await recordCatalogScopeSyncStateForRun(run, new Date().toISOString());
    return run;
  }

  // A unit fast-forwards only when its durable state is "settled" for the
  // CURRENT child execution scope (a mapping change, language edit, or
  // provider re-point invalidates it automatically because the stored child
  // execution scope no longer matches) and the referenced job record still
  // exists and completed — defensive against retention pruning removing the
  // job the durable row still points at.
  async function resolveCatalogScopeSyncFastForwardJobId(
    scopeKey: string,
    unit: CatalogSyncRunSelectedUnitSnapshot,
  ): Promise<string | null> {
    const currentChildExecutionScope = compactStringRecord(unit.childExecutionScope);
    const state = await readCatalogScopeSyncUnitState(deps.db, {
      scopeKey,
      providerKey: unit.providerKey,
      unitKey: unit.unitKey,
    });
    if (!state || !state.last_job_id) {
      return null;
    }
    const fastForwardable = catalogScopeSyncUnitIsFastForwardable({
      state: state.state as CatalogScopeSyncUnitState,
      storedChildExecutionScope: recordFromUnknownStringRecord(state.child_execution_scope),
      currentChildExecutionScope,
    });
    if (!fastForwardable) {
      return null;
    }

    const priorJob = await integrationJobStore.get(state.last_job_id);
    return priorJob && priorJob.status === "completed" ? state.last_job_id : null;
  }

  // Records the initial durable state for every selected unit right after a
  // sync run's fan-out completes (or fast-forwards). One row write per unit;
  // safe to call for every run because the upsert is keyed on
  // (scope, provider, unit) and always reflects the latest known status.
  async function recordCatalogScopeSyncStateForRun(run: CatalogSyncRun, recordedAt: string): Promise<void> {
    const scopeKey = computeCatalogSyncScopeKey(catalogScopeSyncStateDescriptor(run.scope));
    await Promise.all(
      run.childJobs.map((child) => {
        const selectedUnit = run.selectedUnits.find(
          (unit) => unit.providerKey === child.providerKey && unit.unitKey === child.unitKey,
        );
        return upsertCatalogScopeSyncUnitState(deps.db, {
          scopeKey,
          providerKey: child.providerKey,
          unitKey: child.unitKey,
          productDomain: run.scope.productDomain,
          productForm: run.scope.productForm ?? null,
          languageCode: run.scope.languageCode ?? null,
          referenceKind: run.scope.reference.kind,
          scopeRecordId: run.scope.reference.scopeRecordId,
          displayName: child.displayName,
          role: selectedUnit?.role ?? "supplemental-marketplace-reference",
          requirement: selectedUnit?.requirement ?? "optional",
          childExecutionScope: compactStringRecord(child.childExecutionScope),
          status: catalogScopeSyncObservedStatusFromChildLink(child, child.job),
          syncRunId: run.syncRunId,
          jobId: child.childJobId,
          operatorStatus: child.status,
          observedCount: child.job?.result?.observed ?? null,
          // The job result does not decompose "observed" into changed/unchanged
          // per record; `imported` (a fresh source-observation write) is the
          // closest available proxy for "changed" without an extra read against
          // the source-observation scope summary, which can lag a completed
          // job by a projection tick.
          changedCount: child.job?.result?.imported ?? null,
          requestedCount: child.job?.result?.requested ?? null,
          failedCount: child.job?.result?.failed ?? null,
          errorMessage: child.errorMessage ?? child.job?.errorMessage ?? null,
          startedAt: child.job?.startedAt ?? null,
          completedAt: child.job?.completedAt ?? null,
          updatedAt: recordedAt,
        });
      }),
    );
  }

  // Records a single child job's terminal (or retried) status against the
  // durable per-scope state, resolving which unit it belongs to through its
  // parent sync run's selected-unit snapshot. No-ops for jobs that were never
  // part of a "Sync scope" fan-out (reapply jobs, or standalone provider
  // imports started outside a sync run).
  async function recordCatalogScopeSyncStateForChildJob(input: {
    job: SourceObservationIntegrationJob;
    status: CatalogScopeSyncUnitObservedStatus;
    errorMessage: string | null;
    recordedAt: string;
  }): Promise<void> {
    if (input.job.action !== "import" || !input.job.syncRunId) {
      return;
    }
    const parent = await catalogSyncRunStore.get(input.job.syncRunId);
    if (!parent || parent.jobKind !== "catalog-sync-scope") {
      return;
    }
    const unit = parent.payload.selectedUnits.find((candidate) =>
      childExecutionScopesMatch(candidate.childExecutionScope, input.job.scope),
    );
    if (!unit) {
      return;
    }

    const scopeKey = computeCatalogSyncScopeKey(catalogScopeSyncStateDescriptor(parent.payload.scope));
    await upsertCatalogScopeSyncUnitState(deps.db, {
      scopeKey,
      providerKey: unit.providerKey,
      unitKey: unit.unitKey,
      productDomain: parent.payload.scope.productDomain,
      productForm: parent.payload.scope.productForm ?? null,
      languageCode: parent.payload.scope.languageCode ?? null,
      referenceKind: parent.payload.scope.reference.kind,
      scopeRecordId: parent.payload.scope.reference.scopeRecordId,
      displayName: unit.displayName,
      role: unit.role,
      requirement: unit.requirement,
      childExecutionScope: compactStringRecord(unit.childExecutionScope),
      status: input.status,
      syncRunId: input.job.syncRunId,
      jobId: input.job.jobId,
      operatorStatus: input.status === "reused-settled-job" ? "completed" : input.status,
      observedCount: input.job.result?.observed ?? null,
      changedCount: input.job.result?.imported ?? null,
      requestedCount: input.job.result?.requested ?? null,
      failedCount: input.job.result?.failed ?? null,
      errorMessage: input.errorMessage,
      startedAt: input.job.startedAt,
      completedAt: input.job.completedAt,
      updatedAt: input.recordedAt,
    });
  }

  async function getCatalogScopeSyncState(input: {
    scope: CatalogSyncScope;
    context: EventStoreContext;
  }): Promise<readonly CatalogScopeSyncUnitStateReadModel[]> {
    void input.context;
    const scopeKey = computeCatalogSyncScopeKey(
      catalogScopeSyncStateDescriptor(normalizeCatalogSyncScope(input.scope)),
    );
    const rows = await listCatalogScopeSyncState(deps.db, scopeKey);

    return rows.map((row) => ({
      providerKey: row.provider_key,
      unitKey: row.unit_key,
      displayName: row.display_name,
      role: row.role,
      requirement: row.requirement,
      state: row.state as CatalogScopeSyncUnitState,
      lastSyncRunId: row.last_sync_run_id,
      lastJobId: row.last_job_id,
      lastOperatorStatus: row.last_operator_status,
      observedCount: row.observed_count,
      changedCount: row.changed_count,
      requestedCount: row.requested_count,
      failedCount: row.failed_count,
      errorMessage: row.error_message,
      lastStartedAt: row.last_started_at,
      lastCompletedAt: row.last_completed_at,
      updatedAt: row.updated_at,
    }));
  }

  async function getCatalogSyncRun(input: {
    syncRunId: string;
    context: EventStoreContext;
  }): Promise<CatalogSyncRun | null> {
    const job = await catalogSyncRunStore.get(input.syncRunId);
    if (!job || job.jobKind !== "catalog-sync-scope" || !jobMatchesContext(job, input.context)) {
      return null;
    }

    return toCatalogSyncRun(job);
  }

  async function findReusableCatalogSyncRun(
    idempotencyKey: string,
    context: EventStoreContext,
  ): Promise<CatalogSyncRun | null> {
    const candidates = await catalogSyncRunStore.listRecent({
      jobKinds: ["catalog-sync-scope"],
      eventContext: context,
      limit: 50,
    });

    for (const candidate of candidates) {
      if (!jobMatchesContext(candidate, context) || candidate.payload.idempotencyKey !== idempotencyKey) {
        continue;
      }

      const run = await toCatalogSyncRun(candidate);
      if (run.status === "queued" || run.status === "running") {
        return run;
      }
    }

    return null;
  }

  async function completeCatalogSyncRunFanout(
    job: CatalogSyncRunDurableJobRecord,
    childJobs: readonly CatalogSyncRunChildJobLink[],
  ): Promise<CatalogSyncRunDurableJobRecord> {
    const failedChildren = childJobs.filter((childJob) => childJob.syncRunLinkState === "child-enqueue-failed");
    const progress = catalogSyncRunFanoutProgress(
      childJobs.length,
      job.payload.selectedUnits.length,
      null,
      failedChildren.length > 0 ? "child-job-failed" : "child-job-enqueued",
      failedChildren.length > 0 ? "failed" : "completed",
    );
    const result: CatalogSyncRunFanoutResult = { childJobs };
    await deps.db.query(
      `UPDATE catalog_source_observation_integration_durable_jobs
       SET status = $2,
           progress = $3::jsonb,
           result = $4::jsonb,
           error_message = $5,
           completed_at = now(),
           updated_at = now()
       WHERE job_id = $1
         AND job_kind = 'catalog-sync-scope'`,
      [
        job.jobId,
        failedChildren.length > 0 ? "failed" : "completed",
        JSON.stringify(progress),
        JSON.stringify(result),
        failedChildren[0]?.errorMessage ?? null,
      ],
    );

    return (
      (await catalogSyncRunStore.get(job.jobId)) ?? {
        ...job,
        status: failedChildren.length > 0 ? "failed" : "completed",
        progress,
        result,
        errorMessage: failedChildren[0]?.errorMessage ?? null,
        completedAt: new Date().toISOString(),
      }
    );
  }

  async function toCatalogSyncRun(job: CatalogSyncRunDurableJobRecord): Promise<CatalogSyncRun> {
    const childLinks = job.result?.childJobs ?? [];
    const childJobs = await Promise.all(
      childLinks.map(async (link): Promise<CatalogSyncRunChildJob> => {
        const childJob = link.childJobId ? await integrationJobStore.get(link.childJobId) : null;
        const jobSnapshot = childJob ? toSourceObservationIntegrationJob(childJob) : null;
        return {
          ...link,
          status: catalogSyncRunChildStatus(link, jobSnapshot),
          job: jobSnapshot,
        };
      }),
    );
    const progress = catalogSyncRunProgress(childJobs, job.payload.selectedUnits.length);

    return {
      syncRunId: job.jobId,
      scope: job.payload.scope,
      status: catalogSyncRunOperatorStatus(childJobs, job.payload.selectedUnits.length, job.status),
      progress,
      selectedUnits: job.payload.selectedUnits,
      childJobs,
      consistency: {
        duplicateSubmissionPolicy: "reuse-active-sync-run",
        childScopePolicy: "deterministic-from-provider-participation-preview",
        profileSnapshotPolicy: "selected-active-provider-units-snapshotted-at-enqueue",
        childRetryResumeCancelPolicy: "delegated-to-provider-import-jobs",
        partialFailurePolicy: "visible-per-provider-child-job",
      },
      preview: job.payload.preview,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  async function enqueueIntegrationJob(input: {
    action: SourceObservationIntegrationJobAction;
    scope: SourceObservationIntegrationJobScope;
    syncRunId?: string | null;
    reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const scope = normalizeIntegrationJobScope(input.scope);
    rolloutControlPolicy.assertAllowed({
      capability: input.action === "import" ? "import" : "reapply",
      providerKey: scope.provider,
    });
    const importProfileVersion =
      input.action === "import"
        ? await requireCatalogImportProfileVersion(profileVersions, scope.provider, profileSelectorFromScope(scope))
        : null;
    const reapplyProfileMode: SourceObservationReapplyProfileMode | null =
      input.action === "reapply"
        ? (normalizeReapplyProfileMode(input.reapplyProfileMode) ?? "current-active-profile")
        : null;
    const profileSnapshot =
      importProfileVersion === null
        ? reapplyProfileMode === null
          ? null
          : reapplyProfileMode === "current-active-profile"
            ? snapshotCatalogReapplyProfileVersion(
                await requireCatalogReapplyActiveProfileVersion(
                  profileVersions,
                  scope.provider,
                  profileSelectorFromScope(scope),
                ),
              )
            : null
        : snapshotCatalogProfileVersion(importProfileVersion);

    const existingJob = (await integrationJobStore.listActive({ jobKinds: [input.action] }))
      .filter((job) => jobMatchesContext(job, input.context))
      .map(toSourceObservationIntegrationJob)
      .filter((job) => reusableActiveIntegrationJobOperatorStatuses.has(job.operatorStatus))
      .find(
        (job) =>
          JSON.stringify(job.scope) === JSON.stringify(scope) &&
          job.reapplyProfileMode === reapplyProfileMode &&
          integrationProfileSnapshotKey(job.profileSnapshot, job.jobId) ===
            integrationProfileSnapshotKey(profileSnapshot, "new integration job"),
      );
    if (existingJob) {
      return existingJob;
    }

    const jobId = createId("job");
    const unitObservationIds =
      input.action === "reapply"
        ? await listSourceObservationIdsForReapply(deps.db, integrationScopeToObservationScope(scope))
        : [];
    const progress = bulkProgress(0, unitObservationIds.length, null, null, "queued");

    const job = await integrationJobStore.enqueue({
      jobId,
      jobKind: input.action,
      payload: {
        action: input.action,
        scope,
        syncRunId: normalizeOptionalKey(input.syncRunId),
        profileSnapshot,
        reapplyProfileMode,
      },
      progress,
      eventContext: input.context,
    });
    if (input.action === "reapply") {
      await integrationWorkUnitStore.enqueue({
        jobId,
        units: unitObservationIds.map((observationId) => ({
          unitId: observationId,
          unitKind: "reapply",
          payload: { observationId, profileSnapshot, reapplyProfileMode },
        })),
      });
    }

    return toSourceObservationIntegrationJob(job);
  }

  async function retryIntegrationJob(input: {
    jobId: string;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const job = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
    if (job.status === "running" && isDurableJobClaimExpired(job)) {
      return resumeIntegrationJob(input);
    }
    if (job.status === "queued" || job.status === "running") {
      return toSourceObservationIntegrationJob(job);
    }

    const operatorStatus = integrationJobOperatorStatus(job);
    if (operatorStatus === "completed") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Completed provider import jobs without failed outcomes cannot be retried.",
      );
    }

    const retryResult = retryableIntegrationJobResult(job.result, job.progress.total);
    const requeued = await integrationJobStore.requeue({
      jobId: job.jobId,
      progress: bulkProgress(retryResult.outcomes.length, retryResult.requested, null, null, "queued"),
      result: retryResult,
      errorMessage: null,
      allowedStatuses: ["failed", "completed"],
    });

    if (!requeued) {
      const currentJob = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
      if (currentJob.status === "queued" || currentJob.status === "running") {
        return toSourceObservationIntegrationJob(currentJob);
      }
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Provider import job could not be requeued for retry.",
      );
    }

    const retriedJob = toSourceObservationIntegrationJob(requeued);
    // "Per-provider retry from the scope page without touching the settled
    // providers": this only ever touches the ONE unit whose job was just
    // requeued, keyed through its parent sync run — every other unit's
    // durable state is untouched.
    await recordCatalogScopeSyncStateForChildJob({
      job: retriedJob,
      status: "queued",
      errorMessage: null,
      recordedAt: new Date().toISOString(),
    });
    return retriedJob;
  }

  async function resumeIntegrationJob(input: {
    jobId: string;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const job = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
    if (job.status === "queued") {
      return toSourceObservationIntegrationJob(job);
    }
    if (job.status !== "running") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Only queued or stale running provider import jobs can be resumed.",
      );
    }
    if (!isDurableJobClaimExpired(job)) {
      return toSourceObservationIntegrationJob(job);
    }

    const requeued = await integrationJobStore.requeue({
      jobId: job.jobId,
      progress: {
        ...job.progress,
        phase: "queued",
      },
      result: job.result ?? undefined,
      errorMessage: null,
      allowedStatuses: ["running"],
      requireExpiredClaim: true,
    });

    if (!requeued) {
      return toSourceObservationIntegrationJob(await requireImportIntegrationLifecycleJob(input.jobId, input.context));
    }

    const resumedJob = toSourceObservationIntegrationJob(requeued);
    await recordCatalogScopeSyncStateForChildJob({
      job: resumedJob,
      status: "queued",
      errorMessage: null,
      recordedAt: new Date().toISOString(),
    });
    return resumedJob;
  }

  async function cancelIntegrationJob(input: {
    jobId: string;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const job = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
    if (isOperatorCancelledIntegrationJob(job)) {
      return toSourceObservationIntegrationJob(job);
    }
    if (job.status !== "queued" && job.status !== "running") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Only queued or running provider import jobs can be cancelled.",
      );
    }

    const cancelled = await integrationJobStore.cancel({
      jobId: job.jobId,
      progress: {
        ...job.progress,
        phase: "failed",
      },
      errorMessage: OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE,
      allowedStatuses: ["queued", "running"],
    });

    if (!cancelled) {
      const currentJob = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
      if (isOperatorCancelledIntegrationJob(currentJob)) {
        return toSourceObservationIntegrationJob(currentJob);
      }
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Provider import job could not be cancelled from its current state.",
      );
    }

    return toSourceObservationIntegrationJob(cancelled);
  }

  async function requireImportIntegrationLifecycleJob(
    jobId: string,
    context: EventStoreContext,
  ): Promise<SourceObservationIntegrationDurableJobRecord> {
    const job = await integrationJobStore.get(jobId);
    if (!job || !jobMatchesContext(job, context)) {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "job_not_found",
        "Provider import job was not found for the current operator context.",
      );
    }
    if (job.payload.action !== "import") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_action",
        "Only provider import jobs support retry, resume, and cancel lifecycle commands.",
      );
    }

    return job;
  }

  async function processNextIntegrationJob(
    input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
    } & SourceObservationJobRunContext,
  ): Promise<number> {
    if (isJobRunCancelled(input)) {
      return 0;
    }
    if (!rolloutControlPolicy.decide({ capability: "worker-job-processing" }).allowed) {
      return 0;
    }

    const claimedJob = await integrationJobStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      jobKinds: ["import"],
    });
    let claimed = claimedJob ? toClaimedSourceObservationIntegrationJob(claimedJob) : null;
    if (!claimed) {
      const processedReapplyUnit = await processIntegrationReapplyWorkUnit(input);
      if (processedReapplyUnit > 0) {
        return processedReapplyUnit;
      }
      const unitSummary = await integrationWorkUnitStore.summarize();
      if (unitSummary.queued > 0 || unitSummary.running > 0) {
        return 0;
      }
      const reapplyClaimedJob = await integrationJobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: ["reapply"],
      });
      claimed = reapplyClaimedJob ? toClaimedSourceObservationIntegrationJob(reapplyClaimedJob) : null;
      if (!claimed) {
        return 0;
      }
    }

    try {
      throwIfJobRunCancelled(input);
      const turnResult =
        claimed.action === "import"
          ? await processIntegrationImportJobTurn({
              job: claimed,
              claimTtlMs: input.claimTtlMs,
              context: input,
            })
          : await processIntegrationReapplyJobTurn({
              job: claimed,
              claimTtlMs: input.claimTtlMs,
              context: input,
            });

      throwIfJobRunCancelled(input);
      if (turnResult.complete) {
        await requireSourceObservationJobClaim(
          integrationJobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: bulkProgress(turnResult.result.requested, turnResult.result.requested, null, null, "completed"),
            result: turnResult.result,
          }),
        );
        recordIntegrationJobTelemetry(
          deps.sourceObservationTelemetry,
          claimed.action,
          sourceObservationIntegrationJobTelemetryResult(turnResult.result),
        );
        recordIntegrationJobControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, turnResult.result);
        await recordCatalogScopeSyncStateForChildJob({
          job: {
            ...claimed,
            status: "completed",
            result: turnResult.result,
            completedAt: new Date().toISOString(),
          },
          status: turnResult.result.failed > 0 ? "partial" : "completed",
          errorMessage: null,
          recordedAt: new Date().toISOString(),
        });
      } else {
        await requireSourceObservationJobClaim(
          integrationJobStore.releaseClaim({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: turnResult.progress,
            result: turnResult.result,
          }),
        );
        recordIntegrationJobTelemetry(deps.sourceObservationTelemetry, claimed.action, "released");
      }
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        recordIntegrationJobTelemetry(
          deps.sourceObservationTelemetry,
          claimed.action,
          error instanceof SourceObservationJobCancelledError ? "cancelled" : "released",
        );
        return 0;
      }

      const failureMessage = error instanceof Error ? error.message : "Integration job failed.";
      await requireSourceObservationJobClaim(
        integrationJobStore.fail({
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: { ...claimed.progress, phase: "failed" },
          errorMessage: failureMessage,
        }),
      );
      recordIntegrationJobTelemetry(deps.sourceObservationTelemetry, claimed.action, "failed");
      recordIntegrationJobControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, null, "failed");
      await recordCatalogScopeSyncStateForChildJob({
        job: { ...claimed, status: "failed", completedAt: new Date().toISOString() },
        status: "failed",
        errorMessage: failureMessage,
        recordedAt: new Date().toISOString(),
      });
      return 1;
    }
  }

  async function processIntegrationReapplyWorkUnit(
    input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
    } & SourceObservationJobRunContext,
  ): Promise<number> {
    const claimResult = await integrationWorkUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["reapply"],
      laneName: input.laneName ?? null,
    });
    const claim = claimResult.claim;
    if (!claim) {
      return 0;
    }

    const job = toSourceObservationIntegrationJob(claim.job);
    const context = claim.job.eventContext;
    try {
      throwIfJobRunCancelled(input);
      if (!context) {
        throw new Error("Source Observation integration job is missing event context.");
      }
      const runReapplyObservation = createSourceObservationWorkUnitSideEffectRunner(integrationWorkUnitStore, claim, {
        signal: input.signal,
        throwIfLeaseLost: input.throwIfLeaseLost,
        claimTtlMs: input.claimTtlMs,
      });
      const itemResult = await reapplyObservationIds({
        observationIds: [claim.unit.payload.observationId],
        context,
        runReapplyObservation,
        reapplyProfileMode: requireIntegrationJobReapplyProfileMode(
          claim.unit.payload.reapplyProfileMode ?? job.reapplyProfileMode,
          job.jobId,
        ),
        profileSnapshot: claim.unit.payload.profileSnapshot ?? job.profileSnapshot,
      });
      const outcome = integrationReapplyOutcomeFromBulkOutcome(
        job,
        claim.unit.payload.observationId,
        itemResult.outcomes[0],
        await defaultSourceObservationImportProviderKey(profileVersions),
      );
      await requireSourceObservationJobClaim(
        integrationWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: outcome.status === "failed" ? "failed" : outcome.status === "skipped" ? "skipped" : "completed",
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => integrationParentUpdateFromWorkUnits(queryable, job),
        }),
      );
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        await integrationWorkUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        return 0;
      }
      const outcome: SourceObservationIntegrationJobOutcome = {
        providerKey: job.scope.provider || (await defaultSourceObservationImportProviderKey(profileVersions)),
        languageCode: job.scope.language || "",
        expansionId: claim.unit.payload.observationId,
        status: "failed",
        observed: 0,
        reapplied: 0,
        reason: error instanceof Error ? error.message : "Source Observation integration reapply failed.",
      };
      await requireSourceObservationJobClaim(
        integrationWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => integrationParentUpdateFromWorkUnits(queryable, job),
        }),
      );
      return 1;
    }
  }

  async function integrationParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: SourceObservationIntegrationJob,
  ): Promise<
    Readonly<{
      parentProgress: BulkSourceObservationProgress;
      parentResult: SourceObservationIntegrationJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await listIntegrationWorkUnitsForJob(queryable, job.jobId);
    const unitIds = new Set(units.map((unit) => unit.unitId));
    const carriedOutcomes = (job.result?.outcomes ?? []).filter((outcome) => !unitIds.has(outcome.expansionId ?? ""));
    const unitOutcomes = units
      .filter((unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped")
      .flatMap((unit) => (unit.result ? [unit.result] : []));
    const outcomes = [...carriedOutcomes, ...unitOutcomes];
    const total = Math.max(job.progress.total, carriedOutcomes.length + units.length, outcomes.length);
    const completeJob =
      total > 0 &&
      outcomes.length >= total &&
      units.every((unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped");
    const result = summarizeIntegrationJobOutcomes(total, outcomes);
    const latestOutcome = outcomes[outcomes.length - 1] ?? null;
    return {
      parentProgress: bulkProgress(
        outcomes.length,
        total,
        null,
        latestOutcome?.status ?? null,
        completeJob ? "completed" : "processing",
      ),
      parentResult: result,
      completeJob,
    };
  }

  async function processIntegrationImportJobTurn(input: {
    job: ClaimedSourceObservationIntegrationJob;
    claimTtlMs: number;
    context: SourceObservationJobRunContext;
  }): Promise<
    Readonly<{
      complete: boolean;
      progress: BulkSourceObservationProgress;
      result: SourceObservationIntegrationJobResult;
    }>
  > {
    throwIfJobRunCancelled(input.context);
    const scope = normalizeIntegrationJobScope(input.job.scope);
    rolloutControlPolicy.assertAllowed({ capability: "import", providerKey: scope.provider });
    rolloutControlPolicy.assertAllowed({ capability: "provider-transport", providerKey: scope.provider });
    const providerProfileVersion = await requireCatalogImportProfileVersionForJob(
      profileVersions,
      scope.provider,
      input.job.profileSnapshot,
      profileSelectorFromScope(scope),
    );
    const providerProfile = providerProfileVersion.profile;

    return processProviderAdapterIntegrationImportJobTurn({
      job: input.job,
      scope,
      providerProfile,
      providerProfileVersion,
      claimTtlMs: input.claimTtlMs,
      context: input.context,
    });
  }

  async function processIntegrationReapplyJobTurn(input: {
    job: ClaimedSourceObservationIntegrationJob;
    claimTtlMs: number;
    context: SourceObservationJobRunContext;
  }): Promise<
    Readonly<{
      complete: boolean;
      progress: BulkSourceObservationProgress;
      result: SourceObservationIntegrationJobResult;
    }>
  > {
    throwIfJobRunCancelled(input.context);
    rolloutControlPolicy.assertAllowed({ capability: "reapply", providerKey: input.job.scope.provider });
    const scope = integrationScopeToObservationScope(input.job.scope);
    const previousResult = input.job.result ?? summarizeIntegrationJobOutcomes(input.job.progress.total, []);
    const completedObservationIds = new Set(
      previousResult.outcomes.map((outcome) => outcome.expansionId).filter(Boolean),
    );
    const remainingObservationIds = (await listSourceObservationIdsForReapply(deps.db, scope)).filter(
      (observationId) => !completedObservationIds.has(observationId),
    );
    throwIfJobRunCancelled(input.context);
    const total = Math.max(previousResult.requested, previousResult.outcomes.length + remainingObservationIds.length);
    const batchObservationIds = remainingObservationIds.slice(0, INTEGRATION_REAPPLY_JOB_BATCH_SIZE);

    if (batchObservationIds.length === 0) {
      const result = summarizeIntegrationJobOutcomes(total, previousResult.outcomes);
      return {
        complete: true,
        progress: bulkProgress(result.requested, result.requested, null, null, "completed"),
        result,
      };
    }

    const progressHandler = async (progress: BulkSourceObservationProgress) => {
      throwIfJobRunCancelled(input.context);
      const persistedProgress = bulkProgress(
        previousResult.outcomes.length + progress.completed,
        total,
        progress.currentName,
        progress.status,
        progress.phase === "failed" ? "failed" : "processing",
      );
      await requireSourceObservationJobClaim(
        integrationJobStore.updateProgress({
          jobId: input.job.jobId,
          claimOwnerId: input.job.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          progress: persistedProgress,
        }),
      );
    };
    const jobContext = createDurableJobExecutionContext(integrationJobStore, {
      jobId: input.job.jobId,
      claimOwnerId: input.job.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      signal: input.context.signal,
      throwIfLeaseLost: input.context.throwIfLeaseLost,
      cancelledMessage: "Source Observation job run was cancelled.",
      claimLostMessage: "Source Observation job claim was lost before the status update completed.",
    });
    throwIfJobRunCancelled(input.context);
    const batchResult = await reapplyObservationIds({
      observationIds: batchObservationIds,
      context: input.job.eventContext,
      onProgress: progressHandler,
      runReapplyObservation: createSourceObservationSideEffectRunner(jobContext),
      reapplyProfileMode: requireIntegrationJobReapplyProfileMode(input.job.reapplyProfileMode, input.job.jobId),
      profileSnapshot: input.job.profileSnapshot,
    });
    throwIfJobRunCancelled(input.context);

    const defaultProviderKey = await defaultSourceObservationImportProviderKey(profileVersions);
    const outcomes: SourceObservationIntegrationJobOutcome[] = [
      ...previousResult.outcomes,
      ...batchResult.outcomes.map((outcome) => ({
        providerKey: input.job.scope.provider || defaultProviderKey,
        languageCode: input.job.scope.language || "",
        expansionId: outcome.observationId,
        status: outcome.status,
        observed: 0,
        reapplied: outcome.status === "reapplied" ? 1 : 0,
        reason: outcome.reason,
      })),
    ];
    const result = summarizeIntegrationJobOutcomes(total, outcomes);

    return {
      complete:
        result.outcomes.length >= result.requested || remainingObservationIds.length <= batchObservationIds.length,
      progress: bulkProgress(result.outcomes.length, result.requested, null, null, "processing"),
      result,
    };
  }

  async function processProviderAdapterIntegrationImportJobTurn(input: {
    job: ClaimedSourceObservationIntegrationJob;
    scope: SourceObservationIntegrationJobScope;
    providerProfile: CatalogProviderIntegrationProfile;
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    claimTtlMs: number;
    context: SourceObservationJobRunContext;
  }): Promise<
    Readonly<{
      complete: boolean;
      progress: BulkSourceObservationProgress;
      result: SourceObservationIntegrationJobResult;
    }>
  > {
    throwIfJobRunCancelled(input.context);
    const targets = await resolveProviderAdapterImportTargets(input.scope, input.providerProfileVersion);
    throwIfJobRunCancelled(input.context);
    const previousResult = input.job.result ?? summarizeIntegrationJobOutcomes(targets.length, []);
    const completedTargetIds = new Set(
      previousResult.outcomes
        .filter((outcome) => outcome.status !== "failed")
        .map((outcome) => outcome.expansionId)
        .filter(Boolean),
    );
    const nextTarget = targets.find((target) => !completedTargetIds.has(target.targetId));

    if (!nextTarget) {
      const result = summarizeIntegrationJobOutcomes(targets.length, previousResult.outcomes);
      return {
        complete: true,
        progress: bulkProgress(result.requested, result.requested, null, null, "completed"),
        result,
      };
    }

    const jobContext = createDurableJobExecutionContext(integrationJobStore, {
      jobId: input.job.jobId,
      claimOwnerId: input.job.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      signal: input.context.signal,
      throwIfLeaseLost: input.context.throwIfLeaseLost,
      cancelledMessage: "Source Observation job run was cancelled.",
      claimLostMessage: "Source Observation job claim was lost before the status update completed.",
    });
    const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
      minRenewIntervalMs: Math.max(1_000, Math.floor(input.claimTtlMs / 3)),
      completed: (progress) => progress.completed,
      isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
    });
    const recordRenewIntervalMs = Math.max(1_000, Math.floor(input.claimTtlMs / 3));
    let lastRecordRenewedAt = 0;

    await progressCheckpoint.flush(bulkProgress(previousResult.outcomes.length, targets.length, nextTarget.name));

    const outcome = await importProviderAdapterIntegrationTarget({
      target: nextTarget,
      providerProfile: input.providerProfile,
      providerProfileVersion: input.providerProfileVersion,
      syncRunId: input.job.syncRunId,
      context: input.job.eventContext,
      beforeRecordObservation: async () => {
        throwIfJobRunCancelled(input.context);
        const now = Date.now();
        if (lastRecordRenewedAt === 0 || now - lastRecordRenewedAt >= recordRenewIntervalMs) {
          await jobContext.renew();
          lastRecordRenewedAt = Date.now();
        }
      },
      runRecordObservation: createSourceObservationSideEffectRunner(jobContext),
      onProgress: async (targetProgress) => {
        throwIfJobRunCancelled(input.context);
        await progressCheckpoint.checkpoint(
          bulkProgress(
            previousResult.outcomes.length,
            targets.length,
            targetProgress.currentName ?? nextTarget.name,
            null,
            "processing",
          ),
        );
      },
    });
    const result = summarizeIntegrationJobOutcomes(targets.length, [...previousResult.outcomes, outcome]);

    return {
      complete: result.outcomes.length >= result.requested,
      progress: bulkProgress(result.outcomes.length, result.requested, nextTarget.name, outcome.status),
      result,
    };
  }

  async function resolveProviderAdapterImportTargets(
    scope: SourceObservationIntegrationJobScope,
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord,
  ): Promise<readonly ProviderAdapterIntegrationImportTarget[]> {
    const languageCode = scope.language || "en";
    const providerProfile = providerProfileVersion.profile;
    const unitKey = catalogProviderProfileVersionIngestionUnitKey(providerProfileVersion);
    const productId = scope.productId || null;
    if (productId) {
      if (providerProfile.supportedScopes.includes("product")) {
        return [
          {
            targetId: `product:${productId}`,
            name: `Product ${productId}`,
            scopeKey: "product",
            values: { productId, productName: `Product ${productId}`, languageCode },
            languageCode,
          },
        ];
      }

      if (providerProfile.normalizedObservationMapping.kind.endsWith("sealed-product")) {
        return [
          {
            targetId: `sealed:${productId}`,
            name: `Sealed product ${productId}`,
            scopeKey: "single-sealed-product",
            values: { sealedProductId: productId, languageCode },
            languageCode,
          },
        ];
      }

      return [
        {
          targetId: `card:${productId}`,
          name: `Card ${productId}`,
          scopeKey: "single-card",
          values: { cardId: productId, languageCode },
          languageCode,
        },
      ];
    }

    const expansionId = scope.setId?.trim() || null;
    if (expansionId && supportsImportTargetOptionScope(providerProfile, "expansion")) {
      return [
        {
          targetId: expansionId,
          name: scope.setName || expansionId,
          scopeKey: "expansion",
          values: {
            languageCode,
            setId: expansionId,
            expansionId,
            seriesId: scope.seriesId?.trim() ?? "",
          },
          languageCode,
        },
      ];
    }

    if (!expansionId && supportsImportTargetOptionScope(providerProfile, "expansion")) {
      const options = await listProviderImportTargetOptions({
        providerProfileVersion,
        queryScope: "expansion",
        languageCode,
        parentValue: scope.seriesId?.trim() || null,
        unitKey,
      });
      return options.map((option) => ({
        targetId: option.value,
        name: option.label,
        scopeKey: "expansion",
        values: {
          languageCode,
          setId: option.value,
          expansionId: option.value,
          seriesId: option.parentValue ?? scope.seriesId?.trim() ?? "",
        },
        languageCode,
      }));
    }

    const scopedSetName = scope.setName?.trim() || scope.setId?.trim() || null;
    const usesProductLineSetNames = providerProfile.supportedScopes.includes("product-line/category");
    if (scopedSetName && usesProductLineSetNames && supportsImportTargetOptionScope(providerProfile, "set-name")) {
      const productLine = await resolveProductLineImportParent(scope, providerProfileVersion, unitKey);
      return [
        {
          targetId: `set:${productLine.productLineId}:${scopedSetName}`,
          name: scopedSetName,
          scopeKey: "set-name",
          values: {
            productLineId: productLine.productLineId,
            productLineName: productLine.productLineName,
            setName: scopedSetName,
            cleanSetName: scopedSetName,
            languageCode,
          },
          languageCode,
        },
      ];
    }

    if (!scopedSetName && usesProductLineSetNames && supportsImportTargetOptionScope(providerProfile, "set-name")) {
      const productLine = await resolveProductLineImportParent(scope, providerProfileVersion, unitKey);
      const options = await listProviderImportTargetOptions({
        providerProfileVersion,
        queryScope: "set-name",
        languageCode,
        parentValue: productLine.productLineId,
        unitKey,
      });
      return options
        .filter((option) => option.metadata.active !== false)
        .map((option) => {
          const setName =
            option.metadata.cleanSetName === undefined ? option.value : String(option.metadata.cleanSetName);
          return {
            targetId: `set:${productLine.productLineId}:${setName}`,
            name: option.label || setName,
            scopeKey: "set-name",
            values: {
              productLineId: productLine.productLineId,
              productLineName: productLine.productLineName,
              setName,
              cleanSetName: setName,
              languageCode,
            },
            languageCode,
          };
        });
    }

    const setCode = scope.setId || scope.setName || null;
    if (setCode) {
      return [
        {
          targetId: `set:${setCode}`,
          name: scope.setName || setCode,
          scopeKey: "set",
          values: {
            setCode,
            setId: setCode,
            expansionId: setCode,
            ...(scope.setName ? { setName: scope.setName } : {}),
            languageCode,
          },
          languageCode,
        },
      ];
    }

    throw new Error(
      `Provider '${providerProfileVersion.providerKey}' integration unit '${unitKey}' import requires a set code or card id.`,
    );
  }

  function supportsImportTargetOptionScope(
    profile: CatalogProviderIntegrationProfile,
    queryScope: ProviderIntegrationImportTargetOptionScope,
  ): boolean {
    return profile.optionQueries.some((query) => query.scope === queryScope);
  }

  async function listProviderImportTargetOptions(input: {
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    queryScope: ProviderIntegrationImportTargetOptionScope;
    languageCode: string;
    parentValue: string | null;
    unitKey: string;
  }): Promise<readonly CatalogProviderIntegrationOption[]> {
    const query = input.providerProfileVersion.profile.optionQueries.find(
      (candidate) => candidate.scope === input.queryScope,
    );
    if (!query) {
      throw new Error(
        `Provider '${input.providerProfileVersion.providerKey}' profile '${input.providerProfileVersion.profileKey}' does not declare a ${input.queryScope} import target query.`,
      );
    }

    const adapter = providerAdapterForProfileVersion(input.providerProfileVersion);
    const result = await adapter.listOptions({
      unitKey: input.unitKey,
      optionKind: query.queryKind,
      parentValues: {
        languageCode: input.languageCode,
        parentValue: input.parentValue ?? "",
        seriesId: input.queryScope === "expansion" ? (input.parentValue ?? "") : "",
        productLineId: input.queryScope === "set-name" ? (input.parentValue ?? "") : "",
      },
    });

    const records = result.items.map((item) => ({
      value: item.value,
      label: item.label,
      parentValue: item.parentValue ?? input.parentValue ?? null,
      aliases: providerOptionAliasesToJson(item.aliases),
      ...item.metadata,
    }));

    return listCatalogProviderIntegrationOptionsFromProfiles({
      profiles: [input.providerProfileVersion.profile],
      providerKey: input.providerProfileVersion.providerKey,
      queryKind: query.queryKind,
      languageCode: input.languageCode,
      parentValue: input.parentValue,
      defaultProviderKey: input.providerProfileVersion.providerKey,
      transports: {
        listTcgdexExpansions: async () => records,
        listTcgplayerSetNames: async () => records,
      },
    });
  }

  async function resolveProductLineImportParent(
    scope: SourceObservationIntegrationJobScope,
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord,
    unitKey: string,
  ): Promise<Readonly<{ productLineId: string; productLineName: string }>> {
    const productLineId = scope.productLineId?.trim() || scope.seriesId?.trim() || null;
    if (!productLineId) {
      throw new Error(
        `Provider '${providerProfileVersion.providerKey}' set-name import requires productLineId/categoryId or productId.`,
      );
    }

    const query = providerProfileVersion.profile.optionQueries.find(
      (candidate) => candidate.scope === "product-line/category",
    );
    if (!query) {
      return { productLineId, productLineName: productLineId };
    }

    const adapter = providerAdapterForProfileVersion(providerProfileVersion);
    const result = await adapter.listOptions({ unitKey, optionKind: query.queryKind });
    const option = result.items.find((item) => String(item.value).trim() === productLineId);
    if (!option) {
      throw new Error(`Provider product line '${productLineId}' was not found.`);
    }

    const productLineName = option.metadata?.productLineName?.trim() || option.label || productLineId;
    return { productLineId, productLineName };
  }

  async function previewProviderAdapterIntegrationImportTargets(
    scope: SourceObservationIntegrationJobScope,
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord,
  ): Promise<readonly SourceObservationIntegrationImportPreviewTarget[]> {
    const adapter = providerAdapterForProfileVersion(providerProfileVersion);
    const targets = await resolveProviderAdapterImportTargets(scope, providerProfileVersion);
    return Promise.all(
      targets.map(async (target) => {
        const plan = await adapter.planImport({
          unitKey: catalogProviderProfileVersionIngestionUnitKey(providerProfileVersion),
          scopeKey: target.scopeKey,
          values: target.values,
        });
        return integrationImportPreviewTargetFromPlan({
          targetId: target.targetId,
          name: target.name,
          languageCode: target.languageCode,
          plan,
        });
      }),
    );
  }

  async function importProviderAdapterIntegrationTarget(input: {
    target: ProviderAdapterIntegrationImportTarget;
    providerProfile: CatalogProviderIntegrationProfile;
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    syncRunId?: string | null;
    context: EventStoreContext;
    onProgress?: (progress: ProviderAdapterImportProgress) => void | Promise<void>;
    beforeRecordObservation?: () => Promise<void>;
    runRecordObservation?: DurableSideEffectRunner;
    adapterOverride?: ProviderAdapter;
    observedAtForEnvelope?: (envelope: ProviderPayloadEnvelope) => string;
  }): Promise<SourceObservationIntegrationJobOutcome> {
    let providerUsagePlan: ProviderImportPlan | null = null;
    const providerUsageRequestKeys = new Set<string>();
    try {
      const adapter = input.adapterOverride ?? providerAdapterForProfileVersion(input.providerProfileVersion);
      const unitKey = catalogProviderProfileVersionIngestionUnitKey(input.providerProfileVersion);
      const plan = await adapter.planImport({
        unitKey,
        scopeKey: input.target.scopeKey,
        values: input.target.values,
      });
      providerUsagePlan = plan;
      const contract = requireSourceObservationMappingContract(input.providerProfileVersion);
      const importObservedAt = new Date().toISOString();
      const estimatedPayloads = plan.estimatedPayloads ?? 1;
      let observed = 0;
      const payloadFailures: string[] = [];
      const recordedObservations: Array<Readonly<{ observation: SourceObservationRecordInput; payload: JsonValue }>> =
        [];

      for await (const envelope of adapter.fetchPayloads(plan, {
        onProgress: (progress) =>
          input.onProgress?.({
            currentName: progress.currentLabel ?? input.target.name,
            completed: progress.completed,
            total: progress.total,
          }),
      })) {
        const observedAt = input.observedAtForEnvelope?.(envelope) ?? importObservedAt;
        const providerRequestKey = envelope.provenance.sourceUrl?.trim();
        if (providerRequestKey) {
          providerUsageRequestKeys.add(providerRequestKey);
        }
        const preparedPayload = prepareProviderAdapterSourceObservationPayload({
          payload: toJsonValue(envelope.payload),
          providerProfile: input.providerProfile,
        });
        if (preparedPayload.kind === "failure") {
          payloadFailures.push(preparedPayload.reason);
          continue;
        }
        await input.beforeRecordObservation?.();
        const observation = requireCatalogProviderSourceObservation({
          contract,
          payload: preparedPayload.payload,
          observedAt,
        });
        if (observed === 0 && isPokemonCardSourceObservationNormalized(observation.normalized)) {
          await ensurePokemonReferenceHierarchy({
            deps,
            referenceData,
            profile: input.providerProfile,
            normalized: observation.normalized,
            context: input.context,
          });
        }
        const writeObservation = () =>
          recordObservation({ ...observation, syncRunId: input.syncRunId ?? null }, input.context);
        if (input.runRecordObservation) {
          await input.runRecordObservation(writeObservation);
        } else {
          await writeObservation();
        }
        recordedObservations.push({
          observation: { ...observation, syncRunId: input.syncRunId ?? null },
          payload: preparedPayload.payload,
        });
        observed += 1;
        await input.onProgress?.({
          currentName: input.target.name,
          completed: observed,
          total: Math.max(estimatedPayloads, observed),
        });
      }

      await ingestAliasCandidatesForImportedTarget({
        providerProfile: input.providerProfile,
        contract,
        recordedObservations,
        observedAt: importObservedAt,
      });

      if (input.syncRunId && recordedObservations.length > 0) {
        await persistCatalogMergeCandidatesFromObservations(
          recordedObservations.map((recorded) => sourceObservationRecordToCandidateRow(recorded.observation)),
          input.context,
        );
      }

      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: input.target.languageCode,
        expansionId: input.target.targetId,
        status: payloadFailures.length > 0 ? "failed" : observed > 0 ? "imported" : "skipped",
        observed,
        reapplied: 0,
        reason:
          payloadFailures.length > 0
            ? payloadFailureReason(payloadFailures, observed, input.providerProfile.displayName)
            : observed > 0
              ? null
              : `No provider payloads found for ${input.target.name}.`,
        providerUsageEvidence: providerUsageEvidenceFromImportPlan(plan, providerUsageRequestKeys),
      };
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error)) {
        throw error;
      }

      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: input.target.languageCode,
        expansionId: input.target.targetId,
        status: "failed",
        observed: 0,
        reapplied: 0,
        reason: error instanceof Error ? error.message : "Provider adapter import failed.",
        providerUsageEvidence: providerUsagePlan
          ? providerUsageEvidenceFromImportPlan(providerUsagePlan, providerUsageRequestKeys)
          : null,
      };
    }
  }

  function providerAdapterForProfileVersion(
    profileVersion: CatalogProviderIntegrationProfileVersionRecord,
  ): ProviderAdapter<unknown> {
    if (profileVersion.active) {
      return providerAdapterRegistry.require(profileVersion.providerKey);
    }

    if (profileVersion.profile.connector.kind === "tcgdex-json") {
      return createTcgdexProviderAdapter({ loadActiveProfileVersion: async () => profileVersion });
    }

    if (profileVersion.profile.connector.kind === "tcgplayer-automation-client") {
      return createTcgplayerProviderAdapter({
        loadProfileVersions: async () => [profileVersion],
        client: deps.tcgplayerAutomationCatalogClient,
      });
    }

    return providerAdapterRegistry.require(profileVersion.providerKey);
  }

  function payloadFailureReason(failures: readonly string[], observed: number, providerDisplayName: string): string {
    const failureText = failures.length === 1 ? failures[0] : `${failures.length} product details failed.`;
    return observed > 0
      ? `Imported ${observed} ${providerDisplayName} product details before ${failureText}`
      : failureText;
  }

  async function ingestAliasCandidatesForImportedTarget(input: {
    providerProfile: CatalogProviderIntegrationProfile;
    contract: ReturnType<typeof requireSourceObservationMappingContract>;
    recordedObservations: readonly Readonly<{ observation: SourceObservationRecordInput; payload: JsonValue }>[];
    observedAt: string;
  }): Promise<void> {
    if (!input.providerProfile.capabilities.includes("alias-candidate-extraction")) {
      return;
    }

    if (input.providerProfile.connector.kind !== "tcgdex-json") {
      return;
    }

    await ingestTcgdexAliasCandidates({
      profile: input.providerProfile,
      observations: input.recordedObservations.map((recorded) => ({
        observationId: recorded.observation.observationId,
        sourceProfileKey: input.contract.profileKey,
        sourceProfileVersion: input.contract.profileVersion,
        mappingFingerprint: catalogProviderSourceMappingFingerprint(input.contract),
        payload: recorded.payload as TcgdexObservationPayload["payload"],
      })),
      persist: aliasCandidateSink,
      observedAt: input.observedAt,
    });
  }

  async function processIntegrationReapplyJob(input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }): Promise<SourceObservationIntegrationJobResult> {
    const scope = integrationScopeToObservationScope(input.scope);
    const profileSnapshot = snapshotCatalogReapplyProfileVersion(
      await requireCatalogReapplyActiveProfileVersion(
        profileVersions,
        input.scope.provider,
        profileSelectorFromScope(input.scope),
      ),
    );
    const result = await reapplyObservationIds({
      observationIds: await listSourceObservationIdsForReapply(deps.db, scope),
      context: input.context,
      onProgress: input.onProgress,
      reapplyProfileMode: "current-active-profile",
      profileSnapshot,
    });

    const defaultProviderKey = await defaultSourceObservationImportProviderKey(profileVersions);
    return {
      requested: result.requested,
      imported: 0,
      observed: 0,
      reapplied: result.reapplied,
      skipped: result.skipped,
      failed: result.failed,
      outcomes: result.outcomes.map((outcome) => ({
        providerKey: input.scope.provider || defaultProviderKey,
        languageCode: input.scope.language || "",
        expansionId: input.scope.setId || null,
        status: outcome.status,
        observed: 0,
        reapplied: outcome.status === "reapplied" ? 1 : 0,
        reason: outcome.reason,
      })),
    };
  }

  return {
    commandHandler,
    generateCatalogMergeCandidates,
    promoteCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "promote",
        command: {
          type: "PromoteCatalogMergeCandidate",
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          promotedAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    splitCatalogMergeCandidate: async (input) => {
      const splitAt = new Date().toISOString();
      const splitCommand: CatalogMergeCandidateCommand = {
        type: "SplitCatalogMergeCandidate",
        remainingSnapshot: input.remainingSnapshot,
        splitCandidateId: input.splitCandidateId,
        splitSnapshot: input.splitSnapshot,
        reason: input.reason,
        actor: catalogMergeCandidateReviewActor(input.context),
        splitAt,
        conflictResolutions: input.conflictResolutions,
      };
      const originalCandidate = await catalogMergeCandidateRepository.load(
        catalogMergeCandidateStreamId(input.candidateId),
      );
      decideCatalogMergeCandidate(originalCandidate.state, splitCommand);
      const existingSplitEvents = await deps.eventStore.readStream({
        streamId: catalogMergeCandidateStreamId(input.splitCandidateId),
      });
      if (existingSplitEvents.length > 0) {
        throw new Error("Split Catalog Merge Candidate already exists.");
      }

      const splitCandidate = await createSplitCatalogMergeCandidate({
        candidateId: input.splitCandidateId,
        snapshot: input.splitSnapshot,
        createdAt: splitAt,
        context: input.context,
      });
      const original = await dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "split",
        command: splitCommand,
        context: input.context,
      });

      return {
        ...original,
        splitCandidate,
      };
    },
    updateCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "update",
        command: {
          type: "UpdateCatalogMergeCandidate",
          snapshot: input.snapshot,
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          updatedAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    ignoreCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "ignore",
        command: {
          type: "IgnoreCatalogMergeCandidate",
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          ignoredAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    deferCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "defer",
        command: {
          type: "DeferCatalogMergeCandidate",
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          deferredAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    previewCatalogMergeCandidatePromotionPlan: (input) => planCatalogMergeCandidatePromotionCommands(input),
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
    previewDuplicatePreventionCandidates,
    previewReplayReapplyImpact,
    previewProviderProfileLifecycleImpact,
    importProviderAdapterForReplay: async ({ adapter, profileVersion, scope, context }) => {
      const targets = await resolveProviderAdapterImportTargets(scope, profileVersion);
      const outcomes: SourceObservationIntegrationJobOutcome[] = [];
      for (const target of targets) {
        outcomes.push(
          await importProviderAdapterIntegrationTarget({
            target,
            providerProfile: profileVersion.profile,
            providerProfileVersion: profileVersion,
            context,
            adapterOverride: adapter,
            observedAtForEnvelope: (envelope) => envelope.provenance.fetchedAt,
          }),
        );
      }
      return outcomes;
    },
    reconcilePromotedObservationForReplay: async ({ observationId, context, productAssetSource }) => {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation || observation.status !== "promoted" || !observation.promoted_catalog_item_id) {
        throw new Error("Replay reconciliation requires a promoted Catalog Item observation.");
      }
      rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: observation.provider_key });
      const normalized = requireCatalogItemPromotionObservation(observation.normalized, observation.provider_key);
      const providerProfileVersion = await requireCatalogPromotionProfileVersion(
        profileVersions,
        observation.provider_key,
        normalized,
      );
      const providerProfile = providerProfileVersion.profile;
      requirePromotionAssetPorts({ deps, normalized, productAssetSource });
      const catalogItemId = observation.promoted_catalog_item_id as CatalogItemId;
      const planningInput = {
        items,
        referenceData,
        productContents,
        deps,
        catalogItemId,
        normalized,
        providerKey: observation.provider_key,
        externalKey: observation.external_key,
        providerProfile,
        providerProfileVersion,
        catalogMapping: await loadCatalogItemPromotionProfile(deps, providerProfile),
        sourceUpdatedAt: observation.source_updated_at,
        observedAt: observation.observed_at,
        productAssetSource,
        context,
        executeCommands: false,
      } as const;
      const createEvidence = await createCatalogDraftFromObservation(planningInput);
      const refreshEvidence = await refreshCatalogItemFromObservation(planningInput);
      return {
        catalogItemId,
        promotionProfileKey: providerProfileVersion.profileKey,
        promotionProfileVersion: providerProfileVersion.profileVersion,
        promotionPlanFingerprints: [createEvidence.promotionPlanFingerprint, refreshEvidence.promotionPlanFingerprint],
      };
    },
    promoteObservation: async ({ observationId, context, productAssetSource }) => {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation) {
        throw new Error("Source observation was not found.");
      }
      rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: observation.provider_key });

      if (!isPromotableObservationStatus(observation.status)) {
        const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
        if (recovered?.catalogItemId) {
          return {
            observationId,
            catalogItemId: recovered.catalogItemId as CatalogItemId,
          };
        }
        throw new Error("Only observed or changed source observations can be promoted.");
      }

      try {
        const promoted = await promoteObservationFromRow({ observation, context, productAssetSource });
        return {
          observationId: promoted.observationId,
          catalogItemId: promoted.catalogItemId,
          ...(promoted.referenceRecordId ? { referenceRecordId: promoted.referenceRecordId } : {}),
        };
      } catch (error) {
        const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
        if (recovered?.catalogItemId) {
          return {
            observationId,
            catalogItemId: recovered.catalogItemId as CatalogItemId,
          };
        }
        throw error;
      }
    },
    promoteObservations: promoteObservationIds,
    previewPromoteObservations: async ({ observationIds }) =>
      previewSourceObservationPromotionIds(deps.db, observationIds),
    previewPromoteObservationScope: async ({ scope }) => previewSourceObservationPromotionScope(deps.db, scope),
    promoteObservationScope: async ({ scope, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForPromotion(deps.db, scope);
      return promoteObservationIds({
        observationIds,
        context,
        onProgress,
      });
    },
    previewReapplyObservationScope: async ({ scope }) => previewSourceObservationReapplyScope(deps.db, scope),
    reapplyObservations: reapplyObservationIds,
    reapplyObservationScope: async ({ scope, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForReapply(deps.db, scope);
      return reapplyObservationIds({
        observationIds,
        context,
        onProgress,
        reapplyProfileMode: "current-active-profile",
      });
    },
    rejectObservations: rejectObservationIds,
    rejectObservationScope: async ({ scope, reason, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForPromotion(deps.db, scope);
      return rejectObservationIds({
        observationIds,
        reason,
        context,
        onProgress,
      });
    },
    deferObservations: deferObservationIds,
    deferObservationScope: async ({ scope, reason, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForPromotion(deps.db, scope);
      return deferObservationIds({
        observationIds,
        reason,
        context,
        onProgress,
      });
    },
    rejectObservation: async ({ observationId, reason, context }) => {
      await commandHandler({
        streamId: sourceObservationStreamId(observationId),
        command: {
          type: "RejectSourceObservation",
          reason,
        },
        context,
      });
      return { observationId, status: "rejected" };
    },
    enqueueBulkReviewJob,
    getBulkReviewJob: async (jobId, context) => {
      const job = await bulkReviewJobStore.get(jobId);
      if (job && context && !jobMatchesContext(job, context)) {
        return null;
      }
      return job ? toSourceObservationBulkJob(job) : null;
    },
    listBulkReviewJobEvents: async (jobId, afterSequence = 0) =>
      (await bulkReviewJobStore.listEvents(jobId, afterSequence)).map(toSourceObservationJobEvent),
    getBulkReviewPromotionOutcome: async (jobId) =>
      terminalPromotionOutcomeFromEvents(
        jobId,
        (await bulkReviewJobStore.listEvents(jobId)).map(toSourceObservationJobEvent),
      ),
    waitForBulkReviewJobEvents: (jobId, signal) => bulkReviewJobStore.waitForEvents({ jobId, signal }),
    listActiveBulkReviewJobs: async ({ context }) =>
      (await bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "defer", "reapply"] }))
        .filter((job) => jobMatchesContext(job, context))
        .map(toSourceObservationBulkJob),
    processNextBulkReviewJob,
    getBulkReviewWorkUnitSummary: (input = {}) => bulkReviewWorkUnitStore.summarize({ jobId: input.jobId ?? null }),
    previewCatalogSyncScope,
    enqueueCatalogSyncRun,
    getCatalogSyncRun,
    getCatalogScopeSyncState,
    previewIntegrationImport,
    enqueueIntegrationJob,
    retryIntegrationJob,
    resumeIntegrationJob,
    cancelIntegrationJob,
    getIntegrationJob: async (jobId, context) => {
      const job = await integrationJobStore.get(jobId);
      if (job && context && !jobMatchesContext(job, context)) {
        return null;
      }
      return job ? toSourceObservationIntegrationJob(job) : null;
    },
    listIntegrationJobEvents: async (jobId, afterSequence = 0) =>
      (await integrationJobStore.listEvents(jobId, afterSequence)).map(toSourceObservationJobEvent),
    waitForIntegrationJobEvents: (jobId, signal) => integrationJobStore.waitForEvents({ jobId, signal }),
    listActiveIntegrationJobs: async ({ context }) => {
      if (!context) {
        return [];
      }

      return (await integrationJobStore.listActive({ jobKinds: ["import", "reapply"] }))
        .filter((job) => jobMatchesContext(job, context))
        .map(toSourceObservationIntegrationJob);
    },
    listRecentIntegrationJobs: async ({ context, limit }) => {
      if (!context) {
        return [];
      }

      return (
        await integrationJobStore.listRecent({
          jobKinds: ["import", "reapply"],
          eventContext: context,
          limit,
        })
      )
        .filter((job) => jobMatchesContext(job, context))
        .map(toSourceObservationIntegrationJob);
    },
    processNextIntegrationJob,
    getIntegrationWorkUnitSummary: (input = {}) => integrationWorkUnitStore.summarize({ jobId: input.jobId ?? null }),
    listSourceObservations: (params) => listSourceObservations(deps.db, params),
    listCatalogMergeCandidates: (params) => listCatalogMergeCandidates(deps.db, params),
    listIntegrationScopes: (params) => listSourceObservationIntegrationScopes(deps.db, params),
    getCatalogIntegrationControlPlaneReadiness: async () =>
      buildCatalogIntegrationControlPlaneReadiness(providerAdapterRegistry, dryRunProofRegistry, rolloutControlPolicy),
    getCatalogIntegrationRolloutControls: () => rolloutControlPolicy.snapshot(),
    assertCatalogIntegrationRolloutAllowed: rolloutControlPolicy.assertAllowed,
    pruneSourceObservationJobRetention: async (input = {}) => {
      const completedBefore = input.completedBefore ?? sourceObservationRetentionCutoff(7);
      const [bulkReviewJobs, integrationJobs] = await Promise.all([
        bulkReviewJobStore.pruneTerminalJobs({ completedBefore, limit: input.limit }),
        integrationJobStore.pruneTerminalJobs({ completedBefore, limit: input.limit }),
      ]);

      return { bulkReviewJobs, integrationJobs };
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

/**
 * Promotion evidence plus the resolved reference-record ids keyed by reference
 * type key, so promotion alias planning can resolve set/series-equivalent
 * Reference Record targets before writing alias facts.
 */
type CatalogItemPromotionResult = SourceObservationPromotionProfileEvidence &
  Readonly<{ referenceRecordIdsByTypeKey: Readonly<Record<string, string>> }>;

type CatalogItemPromotableSourceObservationNormalized =
  | SourceObservationPokemonCardNormalized
  | SourceObservationPokemonSealedProductNormalized
  | SourceObservationMagicCardPrintNormalized
  | SourceObservationMagicSealedProductNormalized
  | SourceObservationLorcanaCardPrintNormalized
  | SourceObservationLorcanaSealedProductNormalized
  | SourceObservationOnePieceCardPrintNormalized
  | SourceObservationOnePieceSealedProductNormalized
  | SourceObservationYugiohSealedProductNormalized;

type ReferenceHierarchySourceObservationNormalized =
  | CatalogItemPromotableSourceObservationNormalized
  | SourceObservationMagicSetReferenceNormalized
  | SourceObservationLorcanaSetReferenceNormalized
  | SourceObservationOnePieceSetReferenceNormalized;

async function createCatalogDraftFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  productContents: ProductContentServices | null;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  catalogMapping: CatalogProviderPromotionResolvedCatalogMapping;
  sourceUpdatedAt: string | null;
  observedAt: string;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  context: EventStoreContext;
  executeCommands?: boolean;
}): Promise<CatalogItemPromotionResult> {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const { targetReferenceRecordId, referenceRecordIdsByTypeKey } = await resolvePromotionReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    profile: input.providerProfile,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatCatalogItemPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    targetReferenceRecordId,
  });
  const productAssetSet = await normalizePromotionProductAssetSet(input);
  const setReferenceId =
    input.normalized.kind === "magic-card-print" ||
    input.normalized.kind === "magic-sealed-product" ||
    input.normalized.kind === "lorcana-card-print" ||
    input.normalized.kind === "lorcana-sealed-product" ||
    input.normalized.kind === "one-piece-card-print" ||
    input.normalized.kind === "one-piece-sealed-product" ||
    input.normalized.kind === "yugioh-sealed-product"
      ? targetReferenceRecordId
      : undefined;
  const plan = planCatalogProviderPromotionCommands({
    profile: input.providerProfile,
    profileKey: input.providerProfileVersion.profileKey,
    profileVersion: input.providerProfileVersion.profileVersion,
    providerKey: input.providerKey,
    externalKey: input.externalKey,
    mode: "create",
    catalogItemId: input.catalogItemId,
    normalized: input.normalized,
    catalog: {
      blueprintId: input.catalogMapping.blueprintId,
      categoryId: input.catalogMapping.categoryId,
      fieldIds: input.catalogMapping.fieldIds,
    },
    expansionReferenceId:
      input.normalized.kind === "pokemon-card" || input.normalized.kind === "pokemon-sealed-product"
        ? targetReferenceRecordId
        : undefined,
    setReferenceId,
    metadata,
    productAssetSet,
    preflight: { status: "ready" },
  });

  if (input.executeCommands !== false) {
    await executeCatalogItemPromotionCommandPlan({
      items: input.items,
      productContents: input.productContents,
      streamId,
      plan,
      context: input.context,
    });
  }

  return { ...promotionEvidenceFromPlan(plan), referenceRecordIdsByTypeKey };
}

async function refreshCatalogItemFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  productContents: ProductContentServices | null;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  catalogMapping: CatalogProviderPromotionResolvedCatalogMapping;
  sourceUpdatedAt: string | null;
  observedAt: string;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  context: EventStoreContext;
  executeCommands?: boolean;
}): Promise<CatalogItemPromotionResult> {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const { targetReferenceRecordId, referenceRecordIdsByTypeKey } = await resolvePromotionReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    profile: input.providerProfile,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatCatalogItemPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    targetReferenceRecordId,
  });
  const productAssetSet = await normalizePromotionProductAssetSet(input);
  const setReferenceId =
    input.normalized.kind === "magic-card-print" ||
    input.normalized.kind === "magic-sealed-product" ||
    input.normalized.kind === "lorcana-card-print" ||
    input.normalized.kind === "lorcana-sealed-product" ||
    input.normalized.kind === "one-piece-card-print" ||
    input.normalized.kind === "one-piece-sealed-product" ||
    input.normalized.kind === "yugioh-sealed-product"
      ? targetReferenceRecordId
      : undefined;
  const plan = planCatalogProviderPromotionCommands({
    profile: input.providerProfile,
    profileKey: input.providerProfileVersion.profileKey,
    profileVersion: input.providerProfileVersion.profileVersion,
    providerKey: input.providerKey,
    externalKey: input.externalKey,
    mode: "refresh",
    catalogItemId: input.catalogItemId,
    normalized: input.normalized,
    catalog: {
      blueprintId: input.catalogMapping.blueprintId,
      categoryId: input.catalogMapping.categoryId,
      fieldIds: input.catalogMapping.fieldIds,
    },
    expansionReferenceId:
      input.normalized.kind === "pokemon-card" || input.normalized.kind === "pokemon-sealed-product"
        ? targetReferenceRecordId
        : undefined,
    setReferenceId,
    metadata,
    productAssetSet,
    preflight: { status: "ready" },
  });

  if (input.executeCommands !== false) {
    await executeCatalogItemPromotionCommandPlan({
      items: input.items,
      productContents: input.productContents,
      streamId,
      plan,
      context: input.context,
    });
  }

  return { ...promotionEvidenceFromPlan(plan), referenceRecordIdsByTypeKey };
}

/**
 * Build the full promotion alias services from whatever the composition root
 * injected. Only the alias command handler is required; the read side defaults
 * to the read-model over the shared `deps.db`. Returns null when alias
 * promotion was not wired so promotion writes no alias facts.
 */
function resolveAliasPromotionServices(
  deps: CatalogRuntimeDeps,
  aliasPromotion: SourceObservationAliasPromotion | null,
): PromotionAliasServices | null {
  if (!aliasPromotion) {
    return null;
  }
  if (
    "listCandidatesForObservation" in aliasPromotion &&
    "listPublishedCatalogItemAliases" in aliasPromotion &&
    "listPublishedReferenceRecordAliases" in aliasPromotion
  ) {
    return aliasPromotion;
  }
  return {
    ...createPromotionAliasReader(deps.db),
    catalogAliasCommandHandler: aliasPromotion.catalogAliasCommandHandler,
  };
}

function promotionEvidenceFromPlan(
  plan: CatalogProviderPromotionCommandPlanResult,
): SourceObservationPromotionProfileEvidence {
  if (plan.status === "blocked") {
    throw new Error(plan.diagnostics.map((diagnostic) => diagnostic.diagnosticText).join(" "));
  }

  return {
    promotionProfileKey: plan.plan.profileKey,
    promotionProfileVersion: plan.plan.profileVersion,
    promotionPlanFingerprint: plan.plan.planFingerprint,
  };
}

function referenceDataPromotionEvidence(input: {
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized;
  referenceRecordId: ReferenceRecordId;
}): SourceObservationPromotionProfileEvidence {
  return {
    promotionProfileKey: input.providerProfileVersion.profileKey,
    promotionProfileVersion: input.providerProfileVersion.profileVersion,
    promotionPlanFingerprint: referenceDataPromotionPlanFingerprint(input),
  };
}

function referenceDataPromotionPlanFingerprint(input: {
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized;
  referenceRecordId: ReferenceRecordId;
}): string {
  const payload = {
    providerKey: input.providerProfileVersion.providerKey,
    profileKey: input.providerProfileVersion.profileKey,
    profileVersion: input.providerProfileVersion.profileVersion,
    normalizedKind: input.normalized.kind,
    referenceRecordId: input.referenceRecordId,
    setCode: input.normalized.setCode,
    setName: input.normalized.setName,
    releaseDate: input.normalized.releaseDate,
    cardCount: input.normalized.cardCount,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

async function executeCatalogItemPromotionCommandPlan(input: {
  items: CatalogItemServices;
  productContents: ProductContentServices | null;
  streamId: string;
  plan: CatalogProviderPromotionCommandPlanResult;
  context: EventStoreContext;
}) {
  if (input.plan.status === "blocked") {
    throw new Error(input.plan.diagnostics.map((diagnostic) => diagnostic.diagnosticText).join(" "));
  }

  for (const command of input.plan.plan.commands) {
    await executeCatalogItemPromotionCommand({
      items: input.items,
      streamId: input.streamId,
      command,
      context: input.context,
    });
  }

  if (input.plan.plan.productContents) {
    if (!input.productContents) {
      throw new Error("Product Contents services are required to promote reviewed Product Contents evidence.");
    }
    await input.productContents.replaceProductContents(input.plan.plan.productContents.replacement, input.context);
  }
}

async function executeCatalogItemPromotionCommand(input: {
  items: CatalogItemServices;
  streamId: string;
  command: CatalogItemCommand;
  context: EventStoreContext;
}) {
  await input.items.commandHandler({
    streamId: input.streamId,
    command: input.command,
    context: input.context,
  });
}

async function formatCatalogItemPromotionMetadata(input: {
  deps: CatalogRuntimeDeps;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  targetReferenceRecordId: ReferenceRecordId;
}): Promise<{ title: string; subtitle: string }> {
  void input.deps;
  void input.targetReferenceRecordId;
  return {
    title: input.normalized.name,
    subtitle: "",
  };
}

function isPromotableObservationStatus(status: string): boolean {
  return status === "observed" || status === "changed" || status === "promoted";
}

function isReviewableObservationStatus(status: string): boolean {
  return status === "observed" || status === "changed";
}

function requirePromotionAssetPorts(input: {
  deps: CatalogRuntimeDeps;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
}) {
  if (input.productAssetSource || (input.normalized.kind === "pokemon-card" && input.normalized.imageBaseUrl)) {
    requireCatalogAssetStorage(input.deps.assetStorage);
  }
}

async function normalizePromotionProductAssetSet(input: {
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  providerKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  sourceUpdatedAt: string | null;
  observedAt: string;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
}): Promise<ProductAssetSet | null> {
  if (input.productAssetSource) {
    const existing = await findStoredProductAssetSetBySourceHash(
      input.deps.db,
      input.catalogItemId,
      input.productAssetSource.sourceHash,
    );
    if (existing) {
      return existing;
    }

    return normalizeProductAssetSet({
      sourceBody: input.productAssetSource.body,
      sourceContentType: input.productAssetSource.contentType,
      sourceProviderKey: input.providerKey,
      sourceUrl: input.productAssetSource.sourceUrl,
      storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
      generatedAt: input.observedAt,
      assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
    });
  }

  if (input.normalized.kind === "pokemon-card" && input.normalized.imageBaseUrl) {
    return normalizeTcgdexImageAsset({
      profile: input.providerProfile,
      imageBaseUrl: input.normalized.imageBaseUrl,
      storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
      observedAt: input.observedAt,
      fetcher: globalThis.fetch,
      assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
    });
  }

  if (input.normalized.kind === "lorcana-card-print" || input.normalized.kind === "lorcana-sealed-product") {
    const evidence = extractApprovedLorcanaImageEvidence({
      providerKey: input.providerKey,
      imageUrls: input.normalized.imageUrls,
      sourceUpdatedAt: input.sourceUpdatedAt,
      observedAt: input.observedAt,
    });
    if (evidence.status !== "current") {
      return null;
    }

    return normalizeLorcanaImageAsset({
      providerKey: input.providerKey,
      imageUrls: evidence.imageUrls,
      sourceUpdatedAt: input.sourceUpdatedAt,
      observedAt: input.observedAt,
      storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
      fetcher: globalThis.fetch,
      assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
    });
  }

  return null;
}

async function findStoredProductAssetSetBySourceHash(
  db: PgQueryable,
  catalogItemId: CatalogItemId,
  sourceHash: string,
): Promise<ProductAssetSet | null> {
  const result = await db.query<Readonly<{ product_asset_sets: unknown }>>(
    "SELECT product_asset_sets FROM catalog_items WHERE catalog_item_id = $1",
    [catalogItemId],
  );
  const productAssetSets = result.rows[0]?.product_asset_sets;
  if (!Array.isArray(productAssetSets)) {
    return null;
  }

  const normalizedSourceHash = sourceHash.replace(/^sha256:/, "");
  return (
    productAssetSets.find(
      (candidate): candidate is ProductAssetSet =>
        isJsonRecord(candidate) && candidate.kind === "product-image" && candidate.sourceHash === normalizedSourceHash,
    ) ?? null
  );
}

function requireCatalogItemPromotionObservation(
  normalized: SourceObservationNormalized,
  providerKey: string,
): CatalogItemPromotableSourceObservationNormalized {
  if (
    !isPokemonCatalogItemSourceObservationNormalized(normalized) &&
    !isMagicCatalogItemSourceObservationNormalized(normalized) &&
    !isLorcanaCatalogItemSourceObservationNormalized(normalized) &&
    !isOnePieceCatalogItemSourceObservationNormalized(normalized) &&
    !isYugiohCatalogItemSourceObservationNormalized(normalized)
  ) {
    throw new Error(
      `Catalog promotion for provider '${providerKey}' requires a Catalog Item source observation. Normalized kind '${normalized.kind}' is not promotable.`,
    );
  }

  return normalized;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function requireCatalogAssetStorage(assetStorage: CatalogRuntimeDeps["assetStorage"]) {
  if (!assetStorage) {
    throw new Error("Catalog asset storage is required to promote source observation image assets.");
  }

  return assetStorage;
}

function catalogItemAssetObjectBaseKey(catalogItemId: CatalogItemId): string {
  return `catalog/items/${catalogItemId}/product-image`;
}

export async function ensurePokemonReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized: SourceObservationPokemonCardNormalized;
  context: EventStoreContext;
}): Promise<ReferenceRecordId> {
  const result = await resolvePokemonReferenceHierarchy(input);
  return result.targetReferenceRecordId;
}

/**
 * Provision the Pokemon Reference Type/Record hierarchy and return the resolved
 * target (expansion) record id plus a map of every reference type key to its
 * resolved record id. Promotion alias planning needs the per-type-key
 * map so set-equivalent / series-equivalent aliases can resolve their Reference
 * Record id before they become Catalog facts.
 */
export async function resolvePokemonReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized: SourceObservationPokemonCardNormalized;
  context: EventStoreContext;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  return resolvePromotionReferenceHierarchy(input);
}

async function resolvePromotionReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized: ReferenceHierarchySourceObservationNormalized;
  context: EventStoreContext;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  if (input.normalized.kind === "yugioh-sealed-product") {
    return resolveYugiohSealedProductSetReference({
      deps: input.deps,
      normalized: input.normalized,
    });
  }

  const result = await provisionCatalogProviderReferenceHierarchy({
    profile: input.profile,
    payload: promotionReferenceHierarchyPayload(input.normalized),
    provisioner: {
      ensureReferenceType: (def) => ensureReferenceType(input, def),
      ensureReferenceRecord: (def) => ensureReferenceRecord(input, def),
    },
  });

  const referenceRecordIdsByTypeKey: Record<string, string> = {};
  for (const recordRule of input.profile.referenceHierarchyMapping.referenceRecords) {
    const referenceRecordId = result.referenceRecordIdsByRuleKey.get(recordRule.ruleKey);
    if (referenceRecordId) {
      // Last rule per type key wins; expansion/series each have a single rule.
      referenceRecordIdsByTypeKey[recordRule.typeKey.trim().toLowerCase()] = referenceRecordId;
    }
  }

  return {
    targetReferenceRecordId: result.targetReferenceRecordId,
    referenceRecordIdsByTypeKey,
  };
}

export async function resolveYugiohSealedProductSetReference(input: {
  deps: CatalogRuntimeDeps;
  normalized: SourceObservationYugiohSealedProductNormalized;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  const setIds = Array.from(
    new Set(
      (input.normalized.boxOfSetEvidence ?? [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  if (setIds.length === 0) {
    throw new Error(
      "YGOJSON sealed product promotion is blocked because no Yu-Gi-Oh! Set Reference Record id was observed in boxOf evidence.",
    );
  }
  if (setIds.length > 1) {
    throw new Error(
      `YGOJSON sealed product promotion is blocked because boxOf evidence resolves ambiguously to ${setIds.length} Yu-Gi-Oh! sets.`,
    );
  }

  const setId = setIds[0] as string;
  const matches = await input.deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1
       AND attributes ->> $2 = $3
     ORDER BY reference_record_id ASC`,
    ["set", "ygojson-set-id", setId],
  );

  if (matches.rows.length === 0) {
    throw new Error(
      `YGOJSON sealed product promotion is blocked because Yu-Gi-Oh! Set Reference Record '${setId}' is missing.`,
    );
  }
  if (matches.rows.length > 1) {
    throw new Error(
      `YGOJSON sealed product promotion is blocked because Yu-Gi-Oh! Set Reference Record '${setId}' is ambiguous (${matches.rows.length} matches).`,
    );
  }

  const targetReferenceRecordId = matches.rows[0]?.reference_record_id as ReferenceRecordId;
  return {
    targetReferenceRecordId,
    referenceRecordIdsByTypeKey: { set: targetReferenceRecordId },
  };
}

async function resolveReferenceDataPromotionHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized;
  context: EventStoreContext;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  return resolvePromotionReferenceHierarchy(input);
}

function promotionReferenceHierarchyPayload(normalized: ReferenceHierarchySourceObservationNormalized): JsonValue {
  if (normalized.kind === "magic-set-reference") {
    return toJsonValue({
      ...normalized,
      set: {
        code: normalized.setCode,
        name: normalized.setName,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "one-piece-set-reference") {
    return toJsonValue({
      ...normalized,
      expansion: {
        id: normalized.setId,
        code: normalized.setCode,
        name: normalized.setName,
        release_date: normalized.releaseDate,
      },
      set: {
        code: normalized.setCode,
        name: normalized.setName,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "lorcana-set-reference") {
    return toJsonValue({
      ...normalized,
      set: {
        id: normalized.setId,
        code: normalized.setCode,
        name: normalized.setName,
        release_date: normalized.releaseDate,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "magic-card-print" || normalized.kind === "magic-sealed-product") {
    return toJsonValue({
      ...normalized,
      set: normalized.setCode,
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "lorcana-card-print") {
    return toJsonValue({
      ...normalized,
      set: {
        id: normalized.setId,
        code: normalized.setCode,
        name: normalized.setName,
        release_date: normalized.releaseDate,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "lorcana-sealed-product") {
    return toJsonValue({
      ...normalized,
      sealedProduct: {
        set: normalized.setName
          ? {
              id: normalized.setId,
              code: normalized.setCode,
              name: normalized.setName,
              release_date: normalized.releaseDate,
            }
          : null,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "one-piece-card-print") {
    return toJsonValue({
      ...normalized,
      card: {
        expansion: {
          id: normalized.setId,
          code: normalized.setCode,
          name: normalized.setName,
          release_date: normalized.releaseDate,
        },
      },
    });
  }

  if (normalized.kind === "one-piece-sealed-product") {
    return toJsonValue({
      ...normalized,
      sealedProduct: {
        expansion: normalized.setId
          ? {
              id: normalized.setId,
              code: normalized.setCode,
              name: normalized.setName,
              release_date: normalized.releaseDate,
            }
          : null,
      },
    });
  }

  return toJsonValue(normalized);
}

async function ensureReferenceType(
  input: {
    deps: CatalogRuntimeDeps;
    referenceData: ReferenceDataServices;
    context: EventStoreContext;
  },
  def: {
    referenceTypeId: ReferenceTypeId;
    key: string;
    name: string;
    description: string;
    attributeKeys: readonly string[];
  },
): Promise<void> {
  const existing = await input.deps.db.query(
    "SELECT reference_type_id FROM catalog_reference_types WHERE reference_type_id = $1",
    [def.referenceTypeId],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    return;
  }

  const streamId = `catalog.reference-type-${def.referenceTypeId}`;
  try {
    await input.referenceData.referenceTypeCommandHandler({
      streamId,
      command: {
        type: "CreateReferenceType",
        referenceTypeId: def.referenceTypeId,
        key: def.key,
        name: localizedText(def.name),
        description: localizedText(def.description),
        attributeKeys: def.attributeKeys,
      },
      context: input.context,
    });
  } catch (error) {
    if (!isAlreadyCreatedReferenceError(error)) {
      throw error;
    }
  }
  await publishReferenceTypeIfDraft(input.referenceData, streamId, input.context);
}

async function ensureReferenceRecord(
  input: {
    deps: CatalogRuntimeDeps;
    referenceData: ReferenceDataServices;
    context: EventStoreContext;
  },
  def: {
    referenceRecordId: ReferenceRecordId;
    typeKey: string;
    key: string;
    name: string;
    description: string;
    attributes?: Readonly<Record<string, JsonValue>>;
    relationships?: readonly ReferenceRelationship[];
  },
): Promise<ReferenceRecordId> {
  const existing = await input.deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1 AND key = $2
     LIMIT 1`,
    [def.typeKey, def.key],
  );

  if (existing.rows[0]?.reference_record_id) {
    return existing.rows[0].reference_record_id as ReferenceRecordId;
  }

  const existingByProviderAttribute = await findReferenceRecordByProviderAttribute(input.deps, def);
  if (existingByProviderAttribute) {
    return existingByProviderAttribute;
  }

  const streamId = `catalog.reference-record-${def.referenceRecordId}`;
  try {
    await input.referenceData.referenceRecordCommandHandler({
      streamId,
      command: {
        type: "CreateReferenceRecord",
        referenceRecordId: def.referenceRecordId,
        typeKey: def.typeKey,
        key: def.key,
        name: localizedText(def.name),
        description: localizedText(def.description),
        attributes: def.attributes ?? {},
        relationships: def.relationships ?? [],
      },
      context: input.context,
    });
  } catch (error) {
    if (!isAlreadyCreatedReferenceError(error)) {
      throw error;
    }
  }
  await publishReferenceRecordIfDraft(input.referenceData, streamId, input.context);

  return def.referenceRecordId;
}

async function publishReferenceTypeIfDraft(
  referenceData: ReferenceDataServices,
  streamId: string,
  context: EventStoreContext,
) {
  try {
    await referenceData.referenceTypeCommandHandler({
      streamId,
      command: { type: "PublishReferenceType" },
      context,
    });
  } catch (error) {
    if (!isAlreadyPublishedReferenceError(error)) {
      throw error;
    }
  }
}

async function publishReferenceRecordIfDraft(
  referenceData: ReferenceDataServices,
  streamId: string,
  context: EventStoreContext,
) {
  try {
    await referenceData.referenceRecordCommandHandler({
      streamId,
      command: { type: "PublishReferenceRecord" },
      context,
    });
  } catch (error) {
    if (!isAlreadyPublishedReferenceError(error)) {
      throw error;
    }
  }
}

function isAlreadyCreatedReferenceError(error: unknown): boolean {
  return isConcurrencyConflict(error) || (error instanceof Error && error.message.includes("has already been created"));
}

function isAlreadyPublishedReferenceError(error: unknown): boolean {
  return isConcurrencyConflict(error) || (error instanceof Error && error.message.includes("Only draft reference"));
}

function isConcurrencyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "concurrency_conflict"
  );
}

async function findReferenceRecordByProviderAttribute(
  deps: CatalogRuntimeDeps,
  def: {
    typeKey: string;
    attributes?: Readonly<Record<string, JsonValue>>;
  },
): Promise<ReferenceRecordId | null> {
  const providerAttribute = Object.entries(def.attributes ?? {}).find(
    ([key, value]) => isProviderReferenceAttributeKey(key) && typeof value === "string" && value.trim().length > 0,
  );
  const providerAttributeKey = providerAttribute?.[0] ?? null;
  const providerAttributeValue = providerAttribute?.[1] ?? null;

  if (typeof providerAttributeValue !== "string" || providerAttributeValue.trim().length === 0) {
    return null;
  }

  const existing = await deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1
       AND attributes ->> $2 = $3
     LIMIT 1`,
    [def.typeKey, providerAttributeKey, providerAttributeValue],
  );

  return (existing.rows[0]?.reference_record_id as ReferenceRecordId | undefined) ?? null;
}

function isProviderReferenceAttributeKey(key: string): boolean {
  return (
    key.startsWith("tcgdex-") ||
    key.startsWith("tcgplayer-") ||
    key.startsWith("scryfall-") ||
    key.startsWith("mtgjson-") ||
    key.startsWith("scrydex-one-piece-")
  );
}

async function loadCatalogItemPromotionProfile(
  deps: CatalogRuntimeDeps,
  profile: CatalogProviderIntegrationProfile,
): Promise<CatalogProviderPromotionResolvedCatalogMapping> {
  const mapping = profile.catalogFieldMapping;
  const [blueprintId, categoryId, cardNumber, cardName, expansion, rarity, cardVariant, cardIllustrator, releaseYear] =
    await Promise.all([
      requireCatalogIdByKey<BlueprintId>(deps, profile, "catalog_blueprints", "blueprint_id", mapping.blueprintKey),
      requireCatalogIdByKey<CategoryId>(deps, profile, "catalog_categories", "category_id", mapping.categoryKey),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardNumber),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardName),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.expansion),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.rarity),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardVariant),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardIllustrator),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.releaseYear),
    ]);

  return {
    blueprintId,
    categoryId,
    fieldIds: {
      cardNumber,
      cardName,
      expansion,
      rarity,
      cardVariant,
      cardIllustrator,
      releaseYear,
      ...(mapping.fieldKeys.set
        ? {
            set: await requireCatalogIdByKey<FieldId>(
              deps,
              profile,
              "catalog_fields",
              "field_id",
              mapping.fieldKeys.set,
            ),
          }
        : {}),
      ...(mapping.fieldKeys.packCount
        ? {
            packCount: await requireCatalogIdByKey<FieldId>(
              deps,
              profile,
              "catalog_fields",
              "field_id",
              mapping.fieldKeys.packCount,
            ),
          }
        : {}),
    },
  };
}

async function requireCatalogIdByKey<TId extends string>(
  deps: CatalogRuntimeDeps,
  profile: CatalogProviderIntegrationProfile,
  tableName: "catalog_blueprints" | "catalog_categories" | "catalog_fields",
  idColumnName: "blueprint_id" | "category_id" | "field_id",
  key: string,
): Promise<TId> {
  const existing = await deps.db.query<Record<string, string>>(
    `SELECT ${idColumnName} AS id FROM ${tableName} WHERE key = $1 AND status = 'active' LIMIT 1`,
    [key],
  );
  const id = existing.rows[0]?.id;
  if (!id) {
    throw new Error(
      `${profile.displayName} promotion requires active Catalog ${tableName} key '${key}'. Run the Catalog integration bootstrap first.`,
    );
  }

  return id as TId;
}

async function requireCatalogPromotionProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string,
  normalized: SourceObservationNormalized,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const profile = selector
    ? await profileVersions.getActiveProfileVersion(providerKey, selector)
    : selectPromotionProfileVersionForNormalizedKind(await profileVersions.listProfileVersions(providerKey), {
        providerKey,
        normalizedKind: normalized.kind,
      });
  if (
    profile &&
    isActivePromotionProfileVersion(profile) &&
    profile.profile.normalizedObservationMapping.kind === normalized.kind
  ) {
    return profile;
  }

  if (profile && profile.profile.normalizedObservationMapping.kind !== normalized.kind) {
    throw new Error(
      `Provider '${providerKey}' promotion mapping '${profile.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
    );
  }

  throw new Error(`Provider '${providerKey}' does not support Catalog Item promotion.`);
}

async function requireReferenceDataPromotionProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string,
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const profile = selector
    ? await profileVersions.getActiveProfileVersion(providerKey, selector)
    : selectReferenceDataPromotionProfileVersionForNormalizedKind(
        await profileVersions.listProfileVersions(providerKey),
        {
          providerKey,
          normalizedKind: normalized.kind,
        },
      );
  if (
    profile &&
    isActiveReferenceDataPromotionProfileVersion(profile) &&
    profile.profile.normalizedObservationMapping.kind === normalized.kind
  ) {
    return profile;
  }

  if (profile && profile.profile.normalizedObservationMapping.kind !== normalized.kind) {
    throw new Error(
      `Provider '${providerKey}' reference promotion mapping '${profile.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
    );
  }

  throw new Error(`Provider '${providerKey}' does not support Reference Data promotion.`);
}

function selectPromotionProfileVersionForNormalizedKind(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  input: Readonly<{ providerKey: string; normalizedKind: SourceObservationNormalized["kind"] }>,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const matching = versions.filter(
    (version) =>
      version.providerKey.trim().toLowerCase() === input.providerKey.trim().toLowerCase() &&
      isActivePromotionProfileVersion(version) &&
      version.profile.normalizedObservationMapping.kind === input.normalizedKind,
  );
  if (matching.length === 0) {
    return null;
  }
  if (matching.length === 1) {
    return matching[0] ?? null;
  }

  throw new Error(
    `Catalog provider '${input.providerKey}' has multiple active promotion profile units for '${input.normalizedKind}' observations. Select a profileKey or ingestionUnitKey.`,
  );
}

function selectReferenceDataPromotionProfileVersionForNormalizedKind(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  input: Readonly<{ providerKey: string; normalizedKind: SourceObservationNormalized["kind"] }>,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const matching = versions.filter(
    (version) =>
      version.providerKey.trim().toLowerCase() === input.providerKey.trim().toLowerCase() &&
      isActiveReferenceDataPromotionProfileVersion(version) &&
      version.profile.normalizedObservationMapping.kind === input.normalizedKind,
  );
  if (matching.length === 0) {
    return null;
  }
  if (matching.length === 1) {
    return matching[0] ?? null;
  }

  throw new Error(
    `Catalog provider '${input.providerKey}' has multiple active reference promotion profile units for '${input.normalizedKind}' observations. Select a profileKey or ingestionUnitKey.`,
  );
}

function requireOriginalSourceProfileMarker(
  value: string | null | undefined,
  label: string,
  observationId: string,
): string {
  const marker = value?.trim();
  if (!marker || marker.toLowerCase() === "legacy") {
    throw new Error(
      `Source Observation ${observationId} is missing original ${label} and cannot be reapplied with original-source-profile mode.`,
    );
  }
  return marker;
}

function requireIntegrationJobReapplyProfileMode(
  mode: SourceObservationReapplyProfileMode | null | undefined,
  jobId: string,
): SourceObservationReapplyProfileMode {
  if (mode === "current-active-profile" || mode === "original-source-profile") {
    return mode;
  }
  throw new Error(`Source Observation reapply job ${jobId} is missing reapply profile mode.`);
}

function requireBulkJobReapplyProfileMode(
  mode: SourceObservationReapplyProfileMode | null | undefined,
  jobId: string,
): SourceObservationReapplyProfileMode {
  if (mode === "current-active-profile" || mode === "original-source-profile") {
    return mode;
  }
  throw new Error(`Source Observation bulk reapply job ${jobId} is missing reapply profile mode.`);
}

function isActivePromotionProfileVersion(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("catalog-item-promotion")
  );
}

function isActiveReferenceDataPromotionProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("reference-data-promotion")
  );
}

export function requireSourceObservationMappingContract(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderSourceObservationMappingContract {
  const contract = version.executableMappingContract;
  if (!contract?.sourceObservation) {
    throw new Error(
      `Catalog provider '${version.providerKey}' profile version '${version.profileVersion}' does not have a Source Observation mapping contract.`,
    );
  }

  return contract as CatalogProviderSourceObservationMappingContract;
}

export function prepareProviderAdapterSourceObservationPayload(input: {
  payload: JsonValue;
  providerProfile: CatalogProviderIntegrationProfile;
}): Readonly<{ kind: "payload"; payload: JsonValue }> | Readonly<{ kind: "failure"; reason: string }> {
  if (input.providerProfile.connector.kind === "tcgdex-json") {
    return {
      kind: "payload",
      payload:
        isJsonRecord(input.payload) && isJsonRecord(input.payload.payload) ? input.payload.payload : input.payload,
    };
  }

  if (input.providerProfile.connector.kind !== "tcgplayer-automation-client") {
    return { kind: "payload", payload: input.payload };
  }

  if (!isJsonRecord(input.payload)) {
    return { kind: "failure", reason: "TCGplayer adapter returned an invalid product detail payload." };
  }

  if (input.payload.kind === "product-detail-failure") {
    return {
      kind: "failure",
      reason: typeof input.payload.reason === "string" ? input.payload.reason : "TCGplayer product detail failed.",
    };
  }

  if (input.payload.kind !== "product-detail" || !isJsonRecord(input.payload.detail)) {
    return { kind: "failure", reason: "TCGplayer adapter returned an unsupported product payload." };
  }

  const selectedOptionMapping = input.providerProfile.selectedOptionMapping;
  if (!selectedOptionMapping) {
    return { kind: "failure", reason: "TCGplayer import profile must define selected option mapping." };
  }

  return {
    kind: "payload",
    payload: buildTcgplayerAutomationSourceObservationPayload({
      detail: input.payload.detail as TcgplayerAutomationProductDetail,
      selectedOptionMapping,
      externalReferenceRules: input.providerProfile.externalReferenceExtractionRules.rules,
    }),
  };
}

async function defaultSourceObservationImportProviderKey(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
): Promise<string> {
  const activeImportProfiles = (await profileVersions.listProfileVersions()).filter(
    isActiveSourceObservationImportProfileVersion,
  );
  if (activeImportProfiles.length === 0) {
    throw new Error("No active Catalog source observation import provider is configured.");
  }

  return defaultSourceObservationImportProviderKeyFromVersions(activeImportProfiles);
}

function localizedText(value: string): LocalizedTextMap {
  return {
    defaultLocale: "en" as const,
    values: {
      en: value,
    },
  };
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceObservationStreamId(observationId: string): string {
  return `catalog.source-observation-${observationId}`;
}

function catalogMergeCandidateStreamId(candidateId: string): string {
  return `catalog.merge-candidate-${candidateId}`;
}

function catalogMergeCandidateReviewActor(context: EventStoreContext): CatalogMergeCandidateReviewActor {
  return {
    userId: context.audit.performedByUserId ? String(context.audit.performedByUserId) : null,
    accountId: context.audit.forAccountId ? String(context.audit.forAccountId) : null,
  };
}
