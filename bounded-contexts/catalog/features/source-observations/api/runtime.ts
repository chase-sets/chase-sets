import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  DurableJobHandoffError,
  isDurableJobHandoffError,
  runDurableJobSideEffect,
  type DurableJobEvent,
  type DurableJobExecutionContext,
  type DurableJobRecord,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  type DurableJobWorkUnitClaim,
  type DurableJobWorkUnitStore,
  type DurableJobWorkUnitRecord,
  type DurableJobWorkUnitSummary,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { CatalogItemCommand } from "../../catalog-items/domain/domain";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRelationship } from "../../reference-data/domain/domain";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  isPokemonCardSourceObservationNormalized,
  type SourceObservationCommand,
  type SourceObservationEvent,
  type SourceObservationNormalized,
  type SourceObservationPokemonCardNormalized,
  type SourceObservationPromotionProfileEvidence,
  type SourceObservationState,
} from "../domain/domain";
import { buildSourceObservationProjectionHandlers } from "../read-model/projection";
import {
  getSourceObservationDetail,
  listSourceObservationIdsForReapply,
  listSourceObservationIdsForPromotion,
  listSourceObservationIntegrationScopes,
  listSourceObservations,
  previewSourceObservationReapplyScope,
  previewSourceObservationPromotionScope,
  type SourceObservationDetailRow,
  type SourceObservationFilterScope,
  type SourceObservationIntegrationScopeRow,
  type SourceObservationPromotionPreview,
  type SourceObservationReapplyPreview,
} from "../read-model/queries";
import {
  fetchTcgdexExpansionOptions,
  fetchTcgdexSeriesOptions,
  fetchTcgdexSetObservationPayloads,
  listTcgdexLanguageOptions,
  normalizeTcgdexImageAsset,
  type TcgdexExpansionOption,
  type TcgdexLanguageOption,
  type TcgdexSeriesOption,
  type TcgdexSetImportProgress,
  type TcgdexSetImportResult,
} from "./tcgdex-client";
import {
  buildTcgplayerAutomationSourceObservationPayload,
  type TcgplayerAutomationCatalogClient,
  type TcgplayerAutomationProductDetail,
} from "./tcgplayer-automation-catalog-client";
import {
  getActiveCatalogProviderIntegrationProfileVersion,
  listCatalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  catalogProviderSourceMappingFingerprint,
  normalizeCatalogProviderSourceObservation,
  requireCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import {
  createReferenceCardsProviderAdapter,
  isReferenceCardsProofUnit,
  REFERENCE_CARDS_PROFILE_VERSION,
  runReferenceCardsSourceObservationProofDryRun,
} from "./provider-adapters/reference-cards";
import type { ProviderTransportDiagnostic } from "./provider-adapters/provider-adapter";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "./provider-option-query-resolver";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionResolvedCatalogMapping,
  type CatalogProviderPromotionCommandPlanResult,
} from "./provider-promotion-command-planner";
import {
  resolveCatalogProviderDuplicatePrevention,
  type CatalogProviderDuplicatePreventionEvidenceSummary,
} from "./provider-duplicate-prevention-resolver";
import { provisionCatalogProviderReferenceHierarchy } from "./provider-reference-hierarchy-provisioner";

const PRINTED_CARD_COUNT_ATTRIBUTE = "printed-card-count";
const INTEGRATION_REAPPLY_JOB_BATCH_SIZE = 10;

type CatalogProviderIntegrationProfileVersionReader = Pick<
  CatalogProviderIntegrationProfileVersionStore,
  "listProfileVersions" | "getActiveProfileVersion"
>;

const staticCatalogProviderIntegrationProfileVersions: CatalogProviderIntegrationProfileVersionReader = {
  listProfileVersions: async (providerKey?: string | null) => {
    const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
    const versions = listCatalogProviderIntegrationProfileVersions();
    return normalizedProviderKey
      ? versions.filter((version) => version.providerKey.trim().toLowerCase() === normalizedProviderKey)
      : versions;
  },
  getActiveProfileVersion: async (providerKey: string) =>
    getActiveCatalogProviderIntegrationProfileVersion(providerKey),
};

export type BulkSourceObservationPromotionOutcome = Readonly<{
  observationId: string;
  status: "promoted" | "rejected" | "skipped" | "failed";
  catalogItemId: CatalogItemId | null;
  reason: string | null;
}>;

export type BulkSourceObservationPromotionResult = Readonly<{
  requested: number;
  promoted: number;
  rejected?: number;
  skipped: number;
  failed: number;
  outcomes: readonly BulkSourceObservationPromotionOutcome[];
}>;

export type BulkSourceObservationReapplyOutcome = Readonly<{
  observationId: string;
  status: "reapplied" | "skipped" | "failed";
  catalogItemId: CatalogItemId | null;
  reason: string | null;
}>;

export type BulkSourceObservationReapplyResult = Readonly<{
  requested: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomes: readonly BulkSourceObservationReapplyOutcome[];
}>;

export type BulkSourceObservationProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentName: string | null;
  status:
    | BulkSourceObservationPromotionOutcome["status"]
    | BulkSourceObservationReapplyOutcome["status"]
    | "imported"
    | null;
}>;

type SourceObservationProgressHandler = (progress: BulkSourceObservationProgress) => void | Promise<void>;
type DurableSideEffectRunner = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
type SourceObservationRecordInput = Omit<
  Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>,
  "type"
>;

export type SourceObservationBulkJobAction = "promote" | "reject" | "reapply";

export type SourceObservationBulkJobStatus = "queued" | "running" | "completed" | "failed";

type SourceObservationBulkJobPayload = Readonly<{
  action: SourceObservationBulkJobAction;
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: SourceObservationFilterScope;
  reason: string | null;
}>;

type SourceObservationBulkWorkUnitPayload = Readonly<{
  observationId: string;
}>;

type SourceObservationBulkWorkUnitResult = BulkSourceObservationPromotionOutcome | BulkSourceObservationReapplyOutcome;

export type SourceObservationBulkJob = Readonly<{
  jobId: string;
  action: SourceObservationBulkJobAction;
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: SourceObservationFilterScope;
  reason: string | null;
  status: SourceObservationBulkJobStatus;
  progress: BulkSourceObservationProgress;
  result: SourceObservationBulkJobResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type SourceObservationJobEvent<TJob> = Readonly<{
  sequence: number;
  eventName: "status";
  job: TJob;
  createdAt: string;
}>;

export type SourceObservationBulkJobResult = BulkSourceObservationPromotionResult | BulkSourceObservationReapplyResult;

export type SourceObservationJobRunContext = Readonly<{
  signal?: AbortSignal;
  throwIfLeaseLost?: () => void;
}>;

export type SourceObservationIntegrationJobAction = "import" | "reapply";

export type SourceObservationReapplyProfileMode = "original-source-profile" | "current-active-profile";

export type SourceObservationIntegrationJobScope = Readonly<{
  provider?: string;
  language?: string;
  seriesId?: string;
  setId?: string;
  productLineId?: string;
  setName?: string;
  productId?: string;
}>;

type SourceObservationIntegrationJobPayload = Readonly<{
  action: SourceObservationIntegrationJobAction;
  scope: SourceObservationIntegrationJobScope;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

export type SourceObservationIntegrationProfileSnapshot = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
  sourceMappingFingerprint: string;
}>;

type SourceObservationIntegrationWorkUnitPayload = Readonly<{
  observationId: string;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

type TcgplayerIntegrationImportTarget = Readonly<{
  targetId: string;
  name: string;
  productLineId?: number;
  productLineName?: string;
  setName?: string;
  productId?: number;
}>;

type TcgplayerProductImportProgress = Readonly<{
  currentName: string | null;
  completed: number;
  total: number;
}>;

export type SourceObservationIntegrationJobOutcome = Readonly<{
  providerKey: string;
  languageCode: string;
  expansionId: string | null;
  status: "imported" | "reapplied" | "skipped" | "failed";
  observed: number;
  reapplied: number;
  reason: string | null;
}>;

export type SourceObservationIntegrationJobResult = Readonly<{
  requested: number;
  imported: number;
  observed: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomes: readonly SourceObservationIntegrationJobOutcome[];
}>;

export type SourceObservationIntegrationJob = Readonly<{
  jobId: string;
  action: SourceObservationIntegrationJobAction;
  scope: SourceObservationIntegrationJobScope;
  profileSnapshot: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode: SourceObservationReapplyProfileMode | null;
  status: SourceObservationBulkJobStatus;
  progress: BulkSourceObservationProgress;
  result: SourceObservationIntegrationJobResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type SourceObservationIntegrationOption = Readonly<{
  providerKey: string;
  queryKind: string;
  value: string;
  label: string;
  description: string | null;
  parentValue: string | null;
  imageUrl: string | null;
  metadata: Readonly<Record<string, JsonValue>>;
}>;

export type SourceObservationSelectedOptionAuthoringSchema = Readonly<{
  dimensions: readonly Readonly<{
    dimensionId: string;
    dimensionKey: string;
    dimensionName: string;
    status: string;
    options: readonly Readonly<{
      optionId: string;
      optionKey: string;
      optionLabel: string;
      status: string;
    }>[];
  }>[];
}>;

export type SourceObservationPromotionTargetAuthoringSchema = Readonly<{
  blueprints: readonly SourceObservationPromotionTargetAuthoringRecord[];
  categories: readonly SourceObservationPromotionTargetAuthoringRecord[];
  fields: readonly SourceObservationPromotionTargetAuthoringRecord[];
}>;

export type SourceObservationPromotionTargetAuthoringRecord = Readonly<{
  id: string;
  key: string;
  name: string;
  status: string;
}>;

export type SourceObservationDuplicatePreventionCandidatePreview = Readonly<{
  status: "matched" | "none" | "blocked" | "review-only" | "not-evaluated";
  ruleKey: string | null;
  candidateCount: number;
  candidateCatalogItemIds: readonly CatalogItemId[];
  diagnosticText: string | null;
  evidenceSummary: CatalogProviderDuplicatePreventionEvidenceSummary | null;
  evidenceSummaries: readonly CatalogProviderDuplicatePreventionEvidenceSummary[];
}>;

export type CatalogIntegrationControlPlaneReadiness = Readonly<{
  generatedAt: string;
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[];
}>;

export type CatalogIntegrationControlPlaneUnitReadiness = Readonly<{
  unitKey: string;
  providerKey: string;
  displayName: string;
  productDomain: string;
  productForm: string;
  ingestionPurpose: string | null;
  profileVersion: string;
  semanticReadiness: "ready" | "blocked";
  transportReadiness: "ready" | "blocked";
  fixtureValidationStatus: "ready" | "blocked";
  dryRunStatus: "completed" | "blocked";
  observationFacts: number;
  diagnosticCounts: Readonly<{
    info: number;
    warning: number;
    error: number;
  }>;
  latestDiagnosticText: string | null;
  dryRunEvidence: readonly CatalogIntegrationControlPlaneDryRunEvidence[];
}>;

export type CatalogIntegrationControlPlaneDryRunEvidence = Readonly<{
  externalKey: string;
  sourceUrl: string | null;
  sourceHash: string | null;
  normalizedFacts: Readonly<Record<string, string>>;
}>;

export type SourceObservationServices = Readonly<{
  commandHandler: CommandHandler<SourceObservationCommand, SourceObservationState, SourceObservationEvent>;
  importTcgdexSet: (input: {
    languageCode: string;
    setId: string;
    context: EventStoreContext;
    onProgress?: (progress: TcgdexSetImportProgress) => void | Promise<void>;
    beforeRecordObservation?: () => Promise<void>;
    runRecordObservation?: DurableSideEffectRunner;
  }) => Promise<TcgdexSetImportResult>;
  importTcgplayerScope: (input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<SourceObservationIntegrationJobResult>;
  listTcgdexLanguages: () => Promise<readonly TcgdexLanguageOption[]>;
  listTcgdexSeries: (input: { languageCode: string }) => Promise<readonly TcgdexSeriesOption[]>;
  listTcgdexExpansions: (input: {
    languageCode: string;
    seriesId?: string | null;
  }) => Promise<readonly TcgdexExpansionOption[]>;
  listIntegrationOptions: (input: {
    providerKey: string;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
  }) => Promise<readonly SourceObservationIntegrationOption[]>;
  getSelectedOptionAuthoringSchema: () => Promise<SourceObservationSelectedOptionAuthoringSchema>;
  getPromotionTargetAuthoringSchema: () => Promise<SourceObservationPromotionTargetAuthoringSchema>;
  previewDuplicatePreventionCandidates: (input: {
    providerKey: string;
    profileVersion: string;
    payload: JsonValue;
    observedAt?: string;
  }) => Promise<SourceObservationDuplicatePreventionCandidatePreview>;
  promoteObservation: (input: {
    observationId: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; catalogItemId: CatalogItemId }>;
  promoteObservations: (input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationPromotionResult>;
  previewPromoteObservationScope: (input: {
    scope: SourceObservationFilterScope;
  }) => Promise<SourceObservationPromotionPreview>;
  promoteObservationScope: (input: {
    scope: SourceObservationFilterScope;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationPromotionResult>;
  previewReapplyObservationScope: (input: {
    scope: SourceObservationFilterScope;
  }) => Promise<SourceObservationReapplyPreview>;
  reapplyObservations: (input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationReapplyResult>;
  reapplyObservationScope: (input: {
    scope: SourceObservationFilterScope;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationReapplyResult>;
  rejectObservations: (input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationPromotionResult>;
  rejectObservationScope: (input: {
    scope: SourceObservationFilterScope;
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationPromotionResult>;
  rejectObservation: (input: {
    observationId: string;
    reason: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; status: "rejected" }>;
  enqueueBulkReviewJob: (input: {
    action: SourceObservationBulkJobAction;
    observationIds?: readonly string[];
    scope?: SourceObservationFilterScope;
    reason?: string | null;
    context: EventStoreContext;
  }) => Promise<SourceObservationBulkJob>;
  getBulkReviewJob: (jobId: string, context?: EventStoreContext | null) => Promise<SourceObservationBulkJob | null>;
  listBulkReviewJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<readonly SourceObservationJobEvent<SourceObservationBulkJob>[]>;
  waitForBulkReviewJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  listActiveBulkReviewJobs: (input: { context: EventStoreContext }) => Promise<readonly SourceObservationBulkJob[]>;
  processNextBulkReviewJob: (
    input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
    } & SourceObservationJobRunContext,
  ) => Promise<number>;
  getBulkReviewWorkUnitSummary: (input?: { jobId?: string | null }) => Promise<DurableJobWorkUnitSummary>;
  enqueueIntegrationJob: (input: {
    action: SourceObservationIntegrationJobAction;
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }) => Promise<SourceObservationIntegrationJob>;
  getIntegrationJob: (
    jobId: string,
    context?: EventStoreContext | null,
  ) => Promise<SourceObservationIntegrationJob | null>;
  listIntegrationJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<readonly SourceObservationJobEvent<SourceObservationIntegrationJob>[]>;
  waitForIntegrationJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  listActiveIntegrationJobs: (input: {
    context?: EventStoreContext | null;
  }) => Promise<readonly SourceObservationIntegrationJob[]>;
  processNextIntegrationJob: (
    input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
    } & SourceObservationJobRunContext,
  ) => Promise<number>;
  getIntegrationWorkUnitSummary: (input?: { jobId?: string | null }) => Promise<DurableJobWorkUnitSummary>;
  listSourceObservations: (
    params?: Parameters<typeof listSourceObservations>[1],
  ) => ReturnType<typeof listSourceObservations>;
  listIntegrationScopes: (params?: {
    provider?: string;
    language?: string;
    setId?: string;
  }) => Promise<readonly SourceObservationIntegrationScopeRow[]>;
  getCatalogIntegrationControlPlaneReadiness: () => Promise<CatalogIntegrationControlPlaneReadiness>;
  pruneSourceObservationJobRetention: (input?: {
    completedBefore?: string | Date;
    limit?: number;
  }) => Promise<{ bulkReviewJobs: number; integrationJobs: number }>;
  getSourceObservationDetail: (observationId: string) => ReturnType<typeof getSourceObservationDetail>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createSourceObservationRuntime(
  deps: CatalogRuntimeDeps,
  items: CatalogItemServices,
  referenceData: ReferenceDataServices,
  profileVersions: CatalogProviderIntegrationProfileVersionReader = staticCatalogProviderIntegrationProfileVersions,
): SourceObservationServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
      initialState: () => initialSourceObservationState,
      evolve: evolveSourceObservation,
    }),
    evolve: evolveSourceObservation,
    decide: decideSourceObservation,
  });
  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-source-observation-projection",
      handlers: withCatalogAdminRealtimeInvalidation(buildSourceObservationProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-source-observation-projection",
        surface: "source-observations",
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
    { eventSnapshot: toSourceObservationBulkJobEventSnapshot },
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
    { eventSnapshot: toSourceObservationIntegrationJobEventSnapshot },
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
  const providerAdapterRegistry = new ProviderAdapterRegistry([createReferenceCardsProviderAdapter()]);

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

  async function previewDuplicatePreventionCandidates(input: {
    providerKey: string;
    profileVersion: string;
    payload: JsonValue;
    observedAt?: string;
  }): Promise<SourceObservationDuplicatePreventionCandidatePreview> {
    const version =
      (await profileVersions.listProfileVersions(input.providerKey)).find(
        (candidate) => candidate.profileVersion === input.profileVersion,
      ) ?? null;
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

      const normalized = requirePokemonCardPromotionObservation(
        normalization.observation.normalized,
        input.providerKey,
      );
      const catalogMapping = await loadPokemonTcgPromotionProfile(deps, version.profile);
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

  async function promoteObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
  }): Promise<{ observationId: string; catalogItemId: CatalogItemId }> {
    const normalized = requirePokemonCardPromotionObservation(
      input.observation.normalized,
      input.observation.provider_key,
    );
    const providerProfileVersion = await requireCatalogPromotionProfileVersion(
      profileVersions,
      input.observation.provider_key,
      normalized,
    );
    const providerProfile = providerProfileVersion.profile;
    requirePromotionAssetPorts({ deps, normalized });

    const existingCatalogItemId =
      input.observation.status === "changed" || input.observation.status === "promoted"
        ? (input.observation.promoted_catalog_item_id as CatalogItemId | null)
        : null;
    if ((input.observation.status === "changed" || input.observation.status === "promoted") && !existingCatalogItemId) {
      throw new Error(
        `${capitalize(input.observation.status)} source observation is missing its promoted Catalog Item.`,
      );
    }

    const catalogMapping = await loadPokemonTcgPromotionProfile(deps, providerProfile);
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

    const promotionEvidence = reusableCatalogItemId
      ? await refreshCatalogItemFromObservation({
          items,
          referenceData,
          deps,
          catalogItemId: reusableCatalogItemId,
          normalized,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          providerProfile,
          providerProfileVersion,
          catalogMapping,
          context: input.context,
        })
      : await createCatalogDraftFromObservation({
          items,
          referenceData,
          deps,
          catalogItemId,
          normalized,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          providerProfile,
          providerProfileVersion,
          catalogMapping,
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
    };
  }

  async function promoteObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runPromoteObservation?: DurableSideEffectRunner;
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

        if (!isPromotableObservationStatus(observation.status)) {
          const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
          outcomes.push(
            recovered ?? {
              observationId,
              status: "skipped",
              catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
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
    if (latestObservation?.status !== "promoted" || !latestObservation.promoted_catalog_item_id) {
      return null;
    }

    return {
      observationId,
      status: "promoted",
      catalogItemId: latestObservation.promoted_catalog_item_id as CatalogItemId,
      reason: null,
    };
  }

  async function reapplyObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    reapplyProfileMode?: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<{ observationId: string; catalogItemId: CatalogItemId }> {
    const normalized = requirePokemonCardPromotionObservation(
      input.observation.normalized,
      input.observation.provider_key,
    );
    const providerProfileVersion = await requireCatalogPromotionProfileVersionForReapply(
      profileVersions,
      input.observation,
      normalized,
      input.reapplyProfileMode ?? "original-source-profile",
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

    const promotionEvidence = await refreshCatalogItemFromObservation({
      items,
      referenceData,
      deps,
      catalogItemId,
      normalized,
      providerKey: input.observation.provider_key,
      externalKey: input.observation.external_key,
      providerProfile,
      providerProfileVersion,
      catalogMapping: await loadPokemonTcgPromotionProfile(deps, providerProfile),
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

  async function reapplyObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runReapplyObservation?: DurableSideEffectRunner;
    reapplyProfileMode?: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<BulkSourceObservationReapplyResult> {
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

        if (observation.status !== "promoted") {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
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

  async function importTcgdexSetScope(input: {
    languageCode: string;
    setId: string;
    providerProfileVersion?: CatalogProviderIntegrationProfileVersionRecord;
    context: EventStoreContext;
    onProgress?: (progress: TcgdexSetImportProgress) => void | Promise<void>;
    beforeRecordObservation?: () => Promise<void>;
    runRecordObservation?: DurableSideEffectRunner;
  }): Promise<TcgdexSetImportResult> {
    const profileVersion =
      input.providerProfileVersion ?? (await requireCatalogImportProfileVersion(profileVersions, "tcgdex"));
    const profile = profileVersion.profile;
    const contract = requireSourceObservationMappingContract(profileVersion);
    const observationPayloads = await fetchTcgdexSetObservationPayloads({
      profile,
      languageCode: input.languageCode,
      setId: input.setId,
      onProgress: input.onProgress,
    });
    const observations = observationPayloads.map(({ observedAt, payload }) =>
      requireCatalogProviderSourceObservation({
        contract,
        payload,
        observedAt,
      }),
    );

    const firstObservation = observations[0] ?? null;
    if (firstObservation) {
      if (!isPokemonCardSourceObservationNormalized(firstObservation.normalized)) {
        throw new Error("TCGdex import profile must produce Pokemon card Source Observations.");
      }
      await ensurePokemonReferenceHierarchy({
        deps,
        referenceData,
        profile,
        normalized: firstObservation.normalized,
        context: input.context,
      });
    }

    for (const [index, observation] of observations.entries()) {
      await input.beforeRecordObservation?.();
      await (input.runRecordObservation ?? runSourceObservationSideEffectImmediately)(() =>
        recordObservation(observation, input.context),
      );
      await input.onProgress?.({
        phase: "recording",
        completed: index + 1,
        total: observations.length,
        currentName: observation.normalized.name,
      });
    }
    await input.onProgress?.({
      phase: "completed",
      completed: observations.length,
      total: observations.length,
      currentName: null,
    });

    return {
      setId: input.setId,
      expansionId: input.setId,
      languageCode: input.languageCode,
      observed: observations.length,
      observationIds: observations.map((observation) => observation.observationId),
    };
  }

  async function enqueueBulkReviewJob(input: {
    action: SourceObservationBulkJobAction;
    observationIds?: readonly string[];
    scope?: SourceObservationFilterScope;
    reason?: string | null;
    context: EventStoreContext;
  }): Promise<SourceObservationBulkJob> {
    const observationIds = uniqueObservationIds(input.observationIds ?? []);
    const selectionMode = observationIds.length > 0 ? "ids" : "filter";
    const scope = selectionMode === "filter" ? normalizeBulkJobScope(input.scope ?? {}) : {};
    const jobId = createId("job");
    const unitObservationIds =
      selectionMode === "ids" ? observationIds : await listSourceObservationIdsForBulkAction(input.action, scope);
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
      },
      progress,
      eventContext: input.context,
    });
    await bulkReviewWorkUnitStore.enqueue({
      jobId,
      units: unitObservationIds.map((observationId) => ({
        unitId: observationId,
        unitKind: input.action,
        payload: { observationId },
      })),
    });

    return toSourceObservationBulkJob(job);
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

    await ensureBulkReviewWorkUnitsForLegacyJobs();

    const claimResult = await bulkReviewWorkUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["promote", "reject", "reapply"],
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
            })
          : claimed.action === "promote"
            ? await promoteObservationIds({
                observationIds: [observationId],
                context,
                runPromoteObservation: runBulkReviewSideEffect,
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
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        await bulkReviewWorkUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
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
      return 1;
    }
  }

  async function ensureBulkReviewWorkUnitsForLegacyJobs(): Promise<void> {
    const activeJobs = await bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "reapply"] });
    for (const job of activeJobs) {
      const existing = await bulkReviewWorkUnitStore.summarize({ jobId: job.jobId });
      if (existing.total > 0) {
        continue;
      }

      const bulkJob = toSourceObservationBulkJob(job);
      const completedObservationIds = new Set(
        bulkResultOutcomes(bulkJob.result).map((outcome) => outcome.observationId),
      );
      const eligibleObservationIds =
        bulkJob.selectionMode === "ids"
          ? bulkJob.observationIds
          : await listSourceObservationIdsForBulkAction(bulkJob.action, bulkJob.scope);
      const remainingObservationIds = eligibleObservationIds.filter(
        (observationId) => !completedObservationIds.has(observationId),
      );
      await bulkReviewWorkUnitStore.enqueue({
        jobId: bulkJob.jobId,
        units: remainingObservationIds.map((observationId) => ({
          unitId: observationId,
          unitKind: bulkJob.action,
          payload: { observationId },
        })),
      });
    }
  }

  async function reconcileTerminalBulkReviewJobs(): Promise<number> {
    const activeJobs = await bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "reapply"] });
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

  async function enqueueIntegrationJob(input: {
    action: SourceObservationIntegrationJobAction;
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const scope = normalizeIntegrationJobScope(input.scope);
    const importProfileVersion =
      input.action === "import" ? await requireCatalogImportProfileVersion(profileVersions, scope.provider) : null;
    const reapplyProfileMode: SourceObservationReapplyProfileMode | null =
      input.action === "reapply" ? "current-active-profile" : null;
    const profileSnapshot =
      importProfileVersion === null
        ? reapplyProfileMode === null
          ? null
          : snapshotCatalogReapplyProfileVersion(
              await requireCatalogReapplyActiveProfileVersion(profileVersions, scope.provider),
            )
        : snapshotCatalogProfileVersion(importProfileVersion);

    const existingJob = (await integrationJobStore.listActive({ jobKinds: [input.action] }))
      .filter((job) => jobMatchesContext(job, input.context))
      .map(toSourceObservationIntegrationJob)
      .find(
        (job) =>
          JSON.stringify(job.scope) === JSON.stringify(scope) &&
          integrationProfileSnapshotKey(job.profileSnapshot) === integrationProfileSnapshotKey(profileSnapshot),
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
      payload: { action: input.action, scope, profileSnapshot, reapplyProfileMode },
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

    const claimedJob = await integrationJobStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      jobKinds: ["import"],
    });
    let claimed = claimedJob ? toClaimedSourceObservationIntegrationJob(claimedJob) : null;
    if (!claimed) {
      await ensureIntegrationReapplyWorkUnitsForLegacyJobs();
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
      } else {
        await requireSourceObservationJobClaim(
          integrationJobStore.releaseClaim({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: turnResult.progress,
            result: turnResult.result,
          }),
        );
      }
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        return 0;
      }

      await requireSourceObservationJobClaim(
        integrationJobStore.fail({
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: { ...claimed.progress, phase: "failed" },
          errorMessage: error instanceof Error ? error.message : "Integration job failed.",
        }),
      );
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
        reapplyProfileMode:
          claim.unit.payload.reapplyProfileMode ?? job.reapplyProfileMode ?? "original-source-profile",
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

  async function ensureIntegrationReapplyWorkUnitsForLegacyJobs(): Promise<void> {
    const activeJobs = await integrationJobStore.listActive({ jobKinds: ["reapply"] });
    for (const rawJob of activeJobs) {
      const existing = await integrationWorkUnitStore.summarize({ jobId: rawJob.jobId });
      if (existing.total > 0) {
        continue;
      }
      const job = toSourceObservationIntegrationJob(rawJob);
      const completedObservationIds = new Set(
        (job.result?.outcomes ?? []).map((outcome) => outcome.expansionId).filter(Boolean),
      );
      const observationIds = (
        await listSourceObservationIdsForReapply(deps.db, integrationScopeToObservationScope(job.scope))
      ).filter((observationId) => !completedObservationIds.has(observationId));
      await integrationWorkUnitStore.enqueue({
        jobId: job.jobId,
        units: observationIds.map((observationId) => ({
          unitId: observationId,
          unitKind: "reapply",
          payload: {
            observationId,
            profileSnapshot: job.profileSnapshot,
            reapplyProfileMode: job.reapplyProfileMode ?? "original-source-profile",
          },
        })),
      });
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
    const providerProfileVersion = await requireCatalogImportProfileVersionForJob(
      profileVersions,
      scope.provider,
      input.job.profileSnapshot,
    );
    const providerProfile = providerProfileVersion.profile;

    if (providerProfile.providerKey === "tcgplayer") {
      return processTcgplayerIntegrationImportJobTurn({
        job: input.job,
        scope,
        providerProfile,
        providerProfileVersion,
        claimTtlMs: input.claimTtlMs,
        context: input.context,
      });
    }

    const languageCode = scope.language || "en";
    const expansions = scope.setId
      ? [
          {
            expansionId: scope.setId,
            name: scope.setId,
          },
        ]
      : await fetchTcgdexExpansionOptions({
          profile: providerProfile,
          languageCode,
          seriesId: scope.seriesId || null,
        });
    throwIfJobRunCancelled(input.context);
    const previousResult = input.job.result ?? summarizeIntegrationJobOutcomes(expansions.length, []);
    const completedExpansionIds = new Set(
      previousResult.outcomes.map((outcome) => outcome.expansionId).filter(Boolean),
    );
    const nextExpansion = expansions.find((expansion) => !completedExpansionIds.has(expansion.expansionId));

    if (!nextExpansion) {
      const result = summarizeIntegrationJobOutcomes(expansions.length, previousResult.outcomes);
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

    await progressCheckpoint.flush(bulkProgress(previousResult.outcomes.length, expansions.length, nextExpansion.name));

    throwIfJobRunCancelled(input.context);
    const outcome = await importIntegrationExpansion({
      expansion: nextExpansion,
      languageCode,
      providerProfile,
      providerProfileVersion,
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
      onProgress: async (setProgress) => {
        throwIfJobRunCancelled(input.context);
        await progressCheckpoint.checkpoint(
          bulkProgress(
            previousResult.outcomes.length,
            expansions.length,
            setProgress.currentName ?? nextExpansion.name,
            null,
            "processing",
          ),
        );
      },
    });
    const result = summarizeIntegrationJobOutcomes(expansions.length, [...previousResult.outcomes, outcome]);
    const progress = bulkProgress(result.outcomes.length, result.requested, nextExpansion.name, outcome.status);

    return {
      complete: result.outcomes.length >= result.requested,
      progress,
      result,
    };
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
      reapplyProfileMode: input.job.reapplyProfileMode ?? "original-source-profile",
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

  async function processIntegrationImportJob(input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }): Promise<SourceObservationIntegrationJobResult> {
    const scope = normalizeIntegrationJobScope(input.scope);
    const providerProfileVersion = await requireCatalogImportProfileVersion(profileVersions, scope.provider);
    const providerProfile = providerProfileVersion.profile;

    if (providerProfile.providerKey === "tcgplayer") {
      return processTcgplayerIntegrationImportJob({
        scope,
        providerProfileVersion,
        context: input.context,
        onProgress: input.onProgress,
      });
    }

    const languageCode = scope.language || "en";
    const expansions = scope.setId
      ? [
          {
            expansionId: scope.setId,
            name: scope.setId,
          },
        ]
      : await fetchTcgdexExpansionOptions({
          profile: providerProfile,
          languageCode,
          seriesId: scope.seriesId || null,
        });
    const outcomes: SourceObservationIntegrationJobOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, expansions.length));

    for (const expansion of expansions) {
      try {
        const result = await importTcgdexSetScope({
          languageCode,
          setId: expansion.expansionId,
          providerProfileVersion,
          context: input.context,
          onProgress: (progress) =>
            input.onProgress?.(
              bulkProgress(
                outcomes.length,
                expansions.length,
                progress.currentName ?? expansion.name,
                null,
                "processing",
              ),
            ),
        });
        outcomes.push({
          providerKey: providerProfile.providerKey,
          languageCode,
          expansionId: expansion.expansionId,
          status: "imported",
          observed: result.observed,
          reapplied: 0,
          reason: null,
        });
      } catch (error) {
        outcomes.push({
          providerKey: providerProfile.providerKey,
          languageCode,
          expansionId: expansion.expansionId,
          status: "failed",
          observed: 0,
          reapplied: 0,
          reason: error instanceof Error ? error.message : "Import failed.",
        });
      } finally {
        const outcome = outcomes[outcomes.length - 1];
        await input.onProgress?.(
          bulkProgress(outcomes.length, expansions.length, expansion.name, outcome?.status ?? null),
        );
      }
    }

    await input.onProgress?.(bulkProgress(expansions.length, expansions.length, null, null, "completed"));

    return summarizeIntegrationJobOutcomes(expansions.length, outcomes);
  }

  async function importIntegrationExpansion(input: {
    expansion: Readonly<{ expansionId: string; name: string }>;
    languageCode: string;
    providerProfile: CatalogProviderIntegrationProfile;
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    context: EventStoreContext;
    onProgress?: (progress: TcgdexSetImportProgress) => void | Promise<void>;
    beforeRecordObservation?: () => Promise<void>;
    runRecordObservation?: DurableSideEffectRunner;
  }): Promise<SourceObservationIntegrationJobOutcome> {
    try {
      const result = await importTcgdexSetScope({
        languageCode: input.languageCode,
        setId: input.expansion.expansionId,
        providerProfileVersion: input.providerProfileVersion,
        context: input.context,
        onProgress: input.onProgress,
        beforeRecordObservation: input.beforeRecordObservation,
        runRecordObservation: input.runRecordObservation,
      });
      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: input.languageCode,
        expansionId: input.expansion.expansionId,
        status: "imported",
        observed: result.observed,
        reapplied: 0,
        reason: null,
      };
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error)) {
        throw error;
      }

      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: input.languageCode,
        expansionId: input.expansion.expansionId,
        status: "failed",
        observed: 0,
        reapplied: 0,
        reason: error instanceof Error ? error.message : "Import failed.",
      };
    }
  }

  async function processTcgplayerIntegrationImportJobTurn(input: {
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
    const targets = await resolveTcgplayerImportTargets(input.scope);
    throwIfJobRunCancelled(input.context);
    const previousResult = input.job.result ?? summarizeIntegrationJobOutcomes(targets.length, []);
    const completedTargetIds = new Set(previousResult.outcomes.map((outcome) => outcome.expansionId).filter(Boolean));
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

    const outcome = await importTcgplayerIntegrationTarget({
      target: nextTarget,
      providerProfile: input.providerProfile,
      providerProfileVersion: input.providerProfileVersion,
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

  async function processTcgplayerIntegrationImportJob(input: {
    scope: SourceObservationIntegrationJobScope;
    providerProfileVersion?: CatalogProviderIntegrationProfileVersionRecord;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }): Promise<SourceObservationIntegrationJobResult> {
    const scope = normalizeIntegrationJobScope(input.scope);
    const providerProfileVersion =
      input.providerProfileVersion ?? (await requireCatalogImportProfileVersion(profileVersions, scope.provider));
    const providerProfile = providerProfileVersion.profile;
    if (providerProfile.providerKey !== "tcgplayer") {
      throw new Error(`Provider '${providerProfile.providerKey}' is not supported by the TCGplayer import worker.`);
    }
    const targets = await resolveTcgplayerImportTargets(scope);
    const outcomes: SourceObservationIntegrationJobOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, targets.length));

    for (const target of targets) {
      const outcome = await importTcgplayerIntegrationTarget({
        target,
        providerProfile,
        providerProfileVersion,
        context: input.context,
        onProgress: (targetProgress) =>
          input.onProgress?.(
            bulkProgress(
              outcomes.length,
              targets.length,
              targetProgress.currentName ?? target.name,
              null,
              "processing",
            ),
          ),
      });
      outcomes.push(outcome);
      await input.onProgress?.(bulkProgress(outcomes.length, targets.length, target.name, outcome.status));
    }

    await input.onProgress?.(bulkProgress(targets.length, targets.length, null, null, "completed"));

    return summarizeIntegrationJobOutcomes(targets.length, outcomes);
  }

  async function resolveTcgplayerImportTargets(
    scope: SourceObservationIntegrationJobScope,
  ): Promise<readonly TcgplayerIntegrationImportTarget[]> {
    const productId = parsePositiveInteger(scope.productId);
    if (productId !== null) {
      return [
        {
          targetId: `product:${productId}`,
          name: `Product ${productId}`,
          productId,
        },
      ];
    }

    const productLineId = parsePositiveInteger(scope.productLineId ?? scope.seriesId);
    if (productLineId === null) {
      throw new Error("TCGplayer import requires productLineId/categoryId or productId.");
    }

    const client = requireTcgplayerAutomationCatalogClient();
    const productLines = await client.listProductLines();
    const productLine = productLines.find((item) => item.productLineId === productLineId);
    if (!productLine) {
      throw new Error(`TCGplayer product line '${productLineId}' was not found.`);
    }

    const setName = scope.setName?.trim() || scope.setId?.trim() || undefined;
    if (setName) {
      return [
        {
          targetId: `set:${productLineId}:${setName}`,
          name: setName,
          productLineId,
          productLineName: productLine.productLineName,
          setName,
        },
      ];
    }

    const response = await client.listCatalogSetNames({ categoryId: productLineId });
    return response.results
      .filter((setNameOption) => setNameOption.active)
      .map((setNameOption) => ({
        targetId: `set:${productLineId}:${setNameOption.cleanSetName}`,
        name: setNameOption.cleanSetName,
        productLineId,
        productLineName: productLine.productLineName,
        setName: setNameOption.cleanSetName,
      }));
  }

  async function importTcgplayerIntegrationTarget(input: {
    target: TcgplayerIntegrationImportTarget;
    providerProfile: CatalogProviderIntegrationProfile;
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    context: EventStoreContext;
    onProgress?: (progress: TcgplayerProductImportProgress) => void | Promise<void>;
    beforeRecordObservation?: () => Promise<void>;
    runRecordObservation?: DurableSideEffectRunner;
  }): Promise<SourceObservationIntegrationJobOutcome> {
    try {
      const { details, failureReason } = await fetchTcgplayerTargetProductDetails(input.target, input.onProgress);
      if (details.length === 0) {
        return {
          providerKey: input.providerProfile.providerKey,
          languageCode: "en",
          expansionId: input.target.targetId,
          status: failureReason ? "failed" : "skipped",
          observed: 0,
          reapplied: 0,
          reason: failureReason ?? `No TCGplayer products found for ${input.target.name}.`,
        };
      }

      let observed = 0;
      const observedAt = new Date().toISOString();
      const contract = requireSourceObservationMappingContract(input.providerProfileVersion);
      const selectedOptionMapping = input.providerProfile.selectedOptionMapping;
      if (!selectedOptionMapping) {
        throw new Error("TCGplayer import profile must define selected option mapping.");
      }
      for (const detail of details) {
        await input.beforeRecordObservation?.();
        const observation = requireCatalogProviderSourceObservation({
          contract,
          payload: buildTcgplayerAutomationSourceObservationPayload({
            detail,
            selectedOptionMapping,
            externalReferenceRules: input.providerProfile.externalReferenceExtractionRules.rules,
          }),
          observedAt,
        });
        const writeObservation = () => recordObservation(observation, input.context);
        if (input.runRecordObservation) {
          await input.runRecordObservation(writeObservation);
        } else {
          await writeObservation();
        }
        observed += 1;
      }

      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: "en",
        expansionId: input.target.targetId,
        status: failureReason ? "failed" : "imported",
        observed,
        reapplied: 0,
        reason: failureReason,
      };
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error)) {
        throw error;
      }

      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: "en",
        expansionId: input.target.targetId,
        status: "failed",
        observed: 0,
        reapplied: 0,
        reason: error instanceof Error ? error.message : "TCGplayer import failed.",
      };
    }
  }

  async function fetchTcgplayerTargetProductDetails(
    target: TcgplayerIntegrationImportTarget,
    onProgress?: (progress: TcgplayerProductImportProgress) => void | Promise<void>,
  ): Promise<
    Readonly<{
      details: readonly TcgplayerAutomationProductDetail[];
      failureReason: string | null;
    }>
  > {
    const client = requireTcgplayerAutomationCatalogClient();
    if (target.productId !== undefined) {
      await onProgress?.({ currentName: target.name, completed: 0, total: 1 });
      const detail = await client.getProductDetail({ productId: target.productId });
      await onProgress?.({ currentName: detail.productName, completed: 1, total: 1 });
      return { details: [detail], failureReason: null };
    }

    if (!target.productLineName || !target.setName) {
      throw new Error("TCGplayer set import requires a product line name and set name.");
    }

    const products = await client.listAllProducts({
      size: 24,
      filters: {
        term: {
          productLineName: [target.productLineName],
          setName: [target.setName],
        },
      },
      sort: {
        field: "product-sorting-name",
        order: "asc",
      },
    });
    const details: TcgplayerAutomationProductDetail[] = [];
    const failures: string[] = [];
    await onProgress?.({ currentName: target.name, completed: 0, total: products.length });

    for (const product of products) {
      try {
        const detail = await client.getProductDetail({ productId: product.productId });
        details.push(detail);
        await onProgress?.({ currentName: detail.productName, completed: details.length, total: products.length });
      } catch (error) {
        if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error)) {
          throw error;
        }
        failures.push(error instanceof Error ? error.message : `Product ${product.productId} failed.`);
        await onProgress?.({ currentName: product.productName, completed: details.length, total: products.length });
      }
    }

    if (failures.length > 0) {
      const failureText = failures.length === 1 ? failures[0] : `${failures.length} product details failed.`;
      return {
        details,
        failureReason:
          details.length > 0
            ? `Imported ${details.length} TCGplayer product details before ${failureText}`
            : failureText,
      };
    }

    return { details, failureReason: null };
  }

  function requireTcgplayerAutomationCatalogClient(): TcgplayerAutomationCatalogClient {
    if (!deps.tcgplayerAutomationCatalogClient) {
      throw new Error("TCGplayer automation Catalog client is required for TCGplayer imports.");
    }

    return deps.tcgplayerAutomationCatalogClient;
  }

  async function processIntegrationReapplyJob(input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }): Promise<SourceObservationIntegrationJobResult> {
    const scope = integrationScopeToObservationScope(input.scope);
    const profileSnapshot = snapshotCatalogReapplyProfileVersion(
      await requireCatalogReapplyActiveProfileVersion(profileVersions, input.scope.provider),
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
    importTcgdexSet: importTcgdexSetScope,
    importTcgplayerScope: processTcgplayerIntegrationImportJob,
    listTcgdexLanguages: async () =>
      listTcgdexLanguageOptions((await requireCatalogImportProfileVersion(profileVersions, "tcgdex")).profile),
    listTcgdexSeries: async ({ languageCode }) =>
      fetchTcgdexSeriesOptions({
        profile: (await requireCatalogImportProfileVersion(profileVersions, "tcgdex")).profile,
        languageCode,
      }),
    listTcgdexExpansions: async ({ languageCode, seriesId }) =>
      fetchTcgdexExpansionOptions({
        profile: (await requireCatalogImportProfileVersion(profileVersions, "tcgdex")).profile,
        languageCode,
        seriesId,
      }),
    listIntegrationOptions: (input) =>
      listProviderIntegrationOptions(input, deps.tcgplayerAutomationCatalogClient, profileVersions),
    getSelectedOptionAuthoringSchema: async () => loadSelectedOptionAuthoringSchema(deps.db),
    getPromotionTargetAuthoringSchema: async () => loadPromotionTargetAuthoringSchema(deps.db),
    previewDuplicatePreventionCandidates,
    promoteObservation: async ({ observationId, context }) => {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation) {
        throw new Error("Source observation was not found.");
      }

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
        return await promoteObservationFromRow({ observation, context });
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
    waitForBulkReviewJobEvents: (jobId, signal) => bulkReviewJobStore.waitForEvents({ jobId, signal }),
    listActiveBulkReviewJobs: async ({ context }) =>
      (await bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "reapply"] }))
        .filter((job) => jobMatchesContext(job, context))
        .map(toSourceObservationBulkJob),
    processNextBulkReviewJob,
    getBulkReviewWorkUnitSummary: (input = {}) => bulkReviewWorkUnitStore.summarize({ jobId: input.jobId ?? null }),
    enqueueIntegrationJob,
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
    processNextIntegrationJob,
    getIntegrationWorkUnitSummary: (input = {}) => integrationWorkUnitStore.summarize({ jobId: input.jobId ?? null }),
    listSourceObservations: (params) => listSourceObservations(deps.db, params),
    listIntegrationScopes: (params) => listSourceObservationIntegrationScopes(deps.db, params),
    getCatalogIntegrationControlPlaneReadiness: async () =>
      buildCatalogIntegrationControlPlaneReadiness(providerAdapterRegistry),
    pruneSourceObservationJobRetention: async (input = {}) => {
      const completedBefore = input.completedBefore ?? sourceObservationRetentionCutoff(7);
      const [bulkReviewJobs, integrationJobs] = await Promise.all([
        bulkReviewJobStore.pruneTerminalJobs({ completedBefore, limit: input.limit }),
        integrationJobStore.pruneTerminalJobs({ completedBefore, limit: input.limit }),
      ]);

      return { bulkReviewJobs, integrationJobs };
    },
    getSourceObservationDetail: (observationId) => getSourceObservationDetail(deps.db, observationId),
    projectors,
  };
}

async function listProviderIntegrationOptions(
  input: {
    providerKey: string;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
  },
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient,
  profileVersions: CatalogProviderIntegrationProfileVersionReader = staticCatalogProviderIntegrationProfileVersions,
): Promise<readonly SourceObservationIntegrationOption[]> {
  const versions = await profileVersions.listProfileVersions();
  return listCatalogProviderIntegrationOptionsFromProfiles({
    profiles: versions.filter(isActiveProviderOptionQueryProfileVersion).map((version) => version.profile),
    providerKey: input.providerKey,
    queryKind: input.queryKind,
    languageCode: input.languageCode,
    parentValue: input.parentValue,
    defaultProviderKey: await defaultSourceObservationImportProviderKey(profileVersions),
    transports: {
      listTcgdexLanguages: async () =>
        listTcgdexLanguageOptions((await requireCatalogImportProfileVersion(profileVersions, "tcgdex")).profile),
      listTcgdexSeries: async ({ languageCode }) =>
        fetchTcgdexSeriesOptions({
          profile: (await requireCatalogImportProfileVersion(profileVersions, "tcgdex")).profile,
          languageCode,
        }),
      listTcgdexExpansions: async ({ languageCode, seriesId }) =>
        fetchTcgdexExpansionOptions({
          profile: (await requireCatalogImportProfileVersion(profileVersions, "tcgdex")).profile,
          languageCode,
          seriesId,
        }),
      listTcgplayerProductLines: async () =>
        requireTcgplayerAutomationCatalogClient(tcgplayerAutomationCatalogClient).listProductLines(),
      listTcgplayerSetNames: async ({ productLineId }) => {
        const response = await requireTcgplayerAutomationCatalogClient(
          tcgplayerAutomationCatalogClient,
        ).listCatalogSetNames({ categoryId: productLineId });
        return response.results.filter((item) => item.active);
      },
    },
  });
}

async function buildCatalogIntegrationControlPlaneReadiness(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<CatalogIntegrationControlPlaneReadiness> {
  const units: CatalogIntegrationControlPlaneUnitReadiness[] = [];

  for (const providerKey of providerAdapterRegistry.listProviderKeys()) {
    const adapter = providerAdapterRegistry.require(providerKey);
    const [descriptors, transportDiagnostics] = await Promise.all([
      adapter.listIntegrationUnits(),
      adapter.getTransportDiagnostics(),
    ]);

    for (const descriptor of descriptors) {
      const dryRun = isReferenceCardsProofUnit(descriptor.unitKey)
        ? await runReferenceCardsSourceObservationProofDryRun()
        : null;
      const unitDiagnostics = [
        ...transportDiagnostics.filter(
          (diagnostic) => !diagnostic.unitKey || diagnostic.unitKey === descriptor.unitKey,
        ),
        ...(dryRun?.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.diagnosticText,
          unitKey: diagnostic.unitKey,
        })) ?? []),
      ];
      const errorCount = countDiagnostics(unitDiagnostics, "error");

      units.push({
        unitKey: descriptor.unitKey,
        providerKey: descriptor.providerKey,
        displayName: descriptor.displayName,
        productDomain: descriptor.productDomain,
        productForm: descriptor.productForm,
        ingestionPurpose: descriptor.ingestionPurpose ?? null,
        profileVersion: isReferenceCardsProofUnit(descriptor.unitKey) ? REFERENCE_CARDS_PROFILE_VERSION : "",
        semanticReadiness: dryRun && errorCount === 0 && dryRun.observations.length > 0 ? "ready" : "blocked",
        transportReadiness: countDiagnostics(transportDiagnostics, "error") === 0 ? "ready" : "blocked",
        fixtureValidationStatus: dryRun && dryRun.observations.length > 0 ? "ready" : "blocked",
        dryRunStatus: dryRun && errorCount === 0 ? "completed" : "blocked",
        observationFacts: dryRun?.observations.length ?? 0,
        diagnosticCounts: {
          info: countDiagnostics(unitDiagnostics, "info"),
          warning: countDiagnostics(unitDiagnostics, "warning"),
          error: errorCount,
        },
        latestDiagnosticText: unitDiagnostics.at(-1)?.message ?? null,
        dryRunEvidence:
          dryRun?.observations.map((observation) => ({
            externalKey: observation.externalKey,
            sourceUrl: observation.sourceUrl ?? null,
            sourceHash: observation.sourceHash ?? null,
            normalizedFacts: observation.normalizedFacts,
          })) ?? [],
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    units,
  };
}

function countDiagnostics(
  diagnostics: readonly Pick<ProviderTransportDiagnostic, "severity">[],
  severity: ProviderTransportDiagnostic["severity"],
): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
}

function requireTcgplayerAutomationCatalogClient(
  client: TcgplayerAutomationCatalogClient | undefined,
): TcgplayerAutomationCatalogClient {
  if (!client) {
    throw new Error("TCGplayer automation catalog client is required before TCGplayer runtime option queries can run.");
  }

  return client;
}

function normalizeIntegrationKey(value: string): string {
  return value.trim().toLowerCase();
}

async function requireCatalogImportProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string | null | undefined,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const normalizedProvider = normalizeIntegrationKey(
    providerKey || (await defaultSourceObservationImportProviderKey(profileVersions)),
  );
  const version = await profileVersions.getActiveProfileVersion(normalizedProvider);
  if (!version || !isActiveSourceObservationImportProfileVersion(version)) {
    throw new Error(`Provider '${normalizedProvider}' does not support background import.`);
  }

  return version;
}

async function requireCatalogImportProfileVersionForJob(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string | null | undefined,
  snapshot: SourceObservationIntegrationProfileSnapshot | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  if (!snapshot) {
    return requireCatalogImportProfileVersion(profileVersions, providerKey);
  }

  const versions = await profileVersions.listProfileVersions(snapshot.providerKey);
  const version = versions.find(
    (candidate) =>
      candidate.providerKey === snapshot.providerKey &&
      candidate.profileKey === snapshot.profileKey &&
      candidate.profileVersion === snapshot.profileVersion,
  );
  if (!version) {
    throw new Error(
      `Catalog provider profile version ${snapshot.providerKey}@${snapshot.profileVersion} from the integration job snapshot was not found.`,
    );
  }
  if (!version.profile.capabilities.includes("source-observation-import")) {
    throw new Error(`Provider '${snapshot.providerKey}' does not support background import.`);
  }

  return version;
}

async function requireCatalogReapplyActiveProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string | null | undefined,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const normalizedProvider = normalizeIntegrationKey(
    providerKey || (await defaultSourceObservationImportProviderKey(profileVersions)),
  );
  const providerProfile = await profileVersions.getActiveProfileVersion(normalizedProvider);
  if (providerProfile && isActivePromotionProfileVersion(providerProfile)) {
    return providerProfile;
  }

  const compatibleProfile = (await profileVersions.listProfileVersions()).find(isActivePromotionProfileVersion);
  if (compatibleProfile) {
    return compatibleProfile;
  }

  throw new Error(`Provider '${normalizedProvider}' does not support Catalog Item promotion.`);
}

async function requireCatalogPromotionProfileVersionForReapply(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  observation: SourceObservationDetailRow,
  normalized: SourceObservationNormalized,
  mode: SourceObservationReapplyProfileMode,
  snapshot: SourceObservationIntegrationProfileSnapshot | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  if (mode === "current-active-profile") {
    if (snapshot) {
      return requireCatalogPromotionProfileVersionFromSnapshot(profileVersions, snapshot, normalized);
    }
    return requireCatalogPromotionProfileVersion(profileVersions, observation.provider_key, normalized);
  }

  const sourceProfileKey = observation.source_profile_key?.trim() || "legacy";
  const sourceProfileVersion = observation.source_profile_version?.trim() || "legacy";
  if (sourceProfileVersion === "legacy") {
    return requireCatalogPromotionProfileVersion(profileVersions, observation.provider_key, normalized);
  }

  const version = (await profileVersions.listProfileVersions(observation.provider_key)).find(
    (candidate) =>
      candidate.providerKey === observation.provider_key &&
      candidate.profileKey === sourceProfileKey &&
      candidate.profileVersion === sourceProfileVersion,
  );
  if (!version) {
    throw new Error(
      `Catalog provider profile version ${observation.provider_key}@${sourceProfileVersion} from Source Observation ${observation.observation_id} was not found.`,
    );
  }

  assertPromotionProfileCompatible(version, normalized);
  return version;
}

async function requireCatalogPromotionProfileVersionFromSnapshot(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  snapshot: SourceObservationIntegrationProfileSnapshot,
  normalized: SourceObservationNormalized,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const version = await findCatalogProfileVersionFromSnapshot(profileVersions, snapshot);
  if (!version) {
    throw new Error(
      `Catalog provider profile version ${snapshot.providerKey}@${snapshot.profileVersion} from the integration job snapshot was not found.`,
    );
  }

  assertPromotionProfileCompatible(version, normalized);
  return version;
}

async function findCatalogProfileVersionFromSnapshot(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  snapshot: SourceObservationIntegrationProfileSnapshot,
): Promise<CatalogProviderIntegrationProfileVersionRecord | null> {
  const versions = await profileVersions.listProfileVersions(snapshot.providerKey);
  return (
    versions.find(
      (candidate) =>
        candidate.providerKey === snapshot.providerKey &&
        candidate.profileKey === snapshot.profileKey &&
        candidate.profileVersion === snapshot.profileVersion,
    ) ?? null
  );
}

function assertPromotionProfileCompatible(
  version: CatalogProviderIntegrationProfileVersionRecord,
  normalized: SourceObservationNormalized,
): void {
  if (!version.profile.capabilities.includes("catalog-item-promotion")) {
    throw new Error(`Provider '${version.providerKey}' does not support Catalog Item promotion.`);
  }
  if (version.profile.normalizedObservationMapping.kind !== normalized.kind) {
    throw new Error(
      `Provider '${version.providerKey}' promotion mapping '${version.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
    );
  }
}

function snapshotCatalogProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): SourceObservationIntegrationProfileSnapshot {
  return {
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    lifecycle: version.lifecycle,
    sourceMappingFingerprint: catalogProviderSourceMappingFingerprint(requireSourceObservationMappingContract(version)),
  };
}

function snapshotCatalogReapplyProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): SourceObservationIntegrationProfileSnapshot {
  return snapshotCatalogProfileVersion(version);
}

function integrationProfileSnapshotKey(snapshot: SourceObservationIntegrationProfileSnapshot | null): string {
  return snapshot ? `${snapshot.providerKey}:${snapshot.profileKey}:${snapshot.profileVersion}` : "legacy";
}

function normalizeReapplyProfileMode(
  mode: SourceObservationReapplyProfileMode | null | undefined,
): SourceObservationReapplyProfileMode | null {
  return mode === "current-active-profile" || mode === "original-source-profile" ? mode : null;
}

function isActiveSourceObservationImportProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("source-observation-import")
  );
}

function isActiveProviderOptionQueryProfileVersion(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("provider-option-query")
  );
}

async function loadSelectedOptionAuthoringSchema(
  db: PgQueryable,
): Promise<SourceObservationSelectedOptionAuthoringSchema> {
  const result = await db.query<{
    dimension_id: string;
    dimension_key: string;
    dimension_name: string;
    dimension_status: string;
    option_id: string | null;
    option_key: string | null;
    option_label: string | null;
    option_status: string | null;
    display_order: number | null;
  }>(
    `SELECT
       dimension.dimension_id,
       dimension.key AS dimension_key,
       dimension.name AS dimension_name,
       dimension.status AS dimension_status,
       option.option_id,
       option.code AS option_key,
       option.label AS option_label,
       option.status AS option_status,
       option.display_order
     FROM catalog_dimensions AS dimension
     LEFT JOIN catalog_dimension_options AS option
       ON option.dimension_id = dimension.dimension_id
     ORDER BY dimension.key ASC, option.display_order ASC, option.code ASC`,
  );

  const dimensions = new Map<string, SourceObservationSelectedOptionAuthoringSchema["dimensions"][number]>();
  const optionsByDimensionId = new Map<
    string,
    SourceObservationSelectedOptionAuthoringSchema["dimensions"][number]["options"][number][]
  >();

  for (const row of result.rows) {
    if (!dimensions.has(row.dimension_id)) {
      dimensions.set(row.dimension_id, {
        dimensionId: row.dimension_id,
        dimensionKey: row.dimension_key,
        dimensionName: row.dimension_name,
        status: row.dimension_status,
        options: [],
      });
      optionsByDimensionId.set(row.dimension_id, []);
    }

    if (row.option_id) {
      optionsByDimensionId.get(row.dimension_id)?.push({
        optionId: row.option_id,
        optionKey: row.option_key ?? row.option_id,
        optionLabel: row.option_label ?? row.option_key ?? row.option_id,
        status: row.option_status ?? "unknown",
      });
    }
  }

  return {
    dimensions: [...dimensions.values()].map((dimension) => ({
      ...dimension,
      options: optionsByDimensionId.get(dimension.dimensionId) ?? [],
    })),
  };
}

async function loadPromotionTargetAuthoringSchema(
  db: PgQueryable,
): Promise<SourceObservationPromotionTargetAuthoringSchema> {
  const [blueprints, categories, fields] = await Promise.all([
    loadPromotionTargetAuthoringRecords(db, "catalog_blueprints", "blueprint_id"),
    loadPromotionTargetAuthoringRecords(db, "catalog_categories", "category_id"),
    loadPromotionTargetAuthoringRecords(db, "catalog_fields", "field_id"),
  ]);

  return { blueprints, categories, fields };
}

async function loadPromotionTargetAuthoringRecords(
  db: PgQueryable,
  tableName: "catalog_blueprints" | "catalog_categories" | "catalog_fields",
  idColumnName: "blueprint_id" | "category_id" | "field_id",
): Promise<readonly SourceObservationPromotionTargetAuthoringRecord[]> {
  const result = await db.query<{
    id: string;
    key: string;
    name: string;
    status: string;
  }>(
    `SELECT ${idColumnName} AS id, key, name, status
     FROM ${tableName}
     ORDER BY key ASC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
  }));
}

function duplicatePreventionCandidatePreview(
  result: Awaited<ReturnType<typeof resolveCatalogProviderDuplicatePrevention>>,
): SourceObservationDuplicatePreventionCandidatePreview {
  if (result.status === "none") {
    return {
      status: "none",
      ruleKey: null,
      candidateCount: 0,
      candidateCatalogItemIds: [],
      diagnosticText: null,
      evidenceSummary: null,
      evidenceSummaries: result.evidenceSummaries,
    };
  }

  const candidateCatalogItemIds = result.status === "matched" ? [result.catalogItemId] : result.candidateCatalogItemIds;
  return {
    status: result.status,
    ruleKey: result.ruleKey,
    candidateCount: candidateCatalogItemIds.length,
    candidateCatalogItemIds,
    diagnosticText: result.status === "blocked" ? result.diagnosticText : null,
    evidenceSummary: result.evidenceSummary,
    evidenceSummaries: [result.evidenceSummary],
  };
}

function notEvaluatedDuplicatePreventionPreview(
  diagnosticText: string,
): SourceObservationDuplicatePreventionCandidatePreview {
  return {
    status: "not-evaluated",
    ruleKey: null,
    candidateCount: 0,
    candidateCatalogItemIds: [],
    diagnosticText,
    evidenceSummary: null,
    evidenceSummaries: [],
  };
}

async function createCatalogDraftFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationPokemonCardNormalized;
  providerKey: string;
  externalKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  catalogMapping: CatalogProviderPromotionResolvedCatalogMapping;
  context: EventStoreContext;
}): Promise<SourceObservationPromotionProfileEvidence> {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const expansionReferenceId = await ensurePokemonReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    profile: input.providerProfile,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatPokemonCardPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    expansionReferenceId,
  });
  const productAssetSet = input.normalized.imageBaseUrl
    ? await normalizeTcgdexImageAsset({
        profile: input.providerProfile,
        imageBaseUrl: input.normalized.imageBaseUrl,
        storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
        observedAt: new Date().toISOString(),
        fetcher: globalThis.fetch,
        assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
      })
    : null;
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
    expansionReferenceId,
    metadata,
    productAssetSet,
    preflight: { status: "ready" },
  });

  await executeCatalogItemPromotionCommandPlan({
    items: input.items,
    streamId,
    plan,
    context: input.context,
  });

  return promotionEvidenceFromPlan(plan);
}

async function refreshCatalogItemFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationPokemonCardNormalized;
  providerKey: string;
  externalKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  catalogMapping: CatalogProviderPromotionResolvedCatalogMapping;
  context: EventStoreContext;
}): Promise<SourceObservationPromotionProfileEvidence> {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const expansionReferenceId = await ensurePokemonReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    profile: input.providerProfile,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatPokemonCardPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    expansionReferenceId,
  });
  const productAssetSet = input.normalized.imageBaseUrl
    ? await normalizeTcgdexImageAsset({
        profile: input.providerProfile,
        imageBaseUrl: input.normalized.imageBaseUrl,
        storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
        observedAt: new Date().toISOString(),
        fetcher: globalThis.fetch,
        assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
      })
    : null;
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
    expansionReferenceId,
    metadata,
    productAssetSet,
    preflight: { status: "ready" },
  });

  await executeCatalogItemPromotionCommandPlan({
    items: input.items,
    streamId,
    plan,
    context: input.context,
  });

  return promotionEvidenceFromPlan(plan);
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

async function executeCatalogItemPromotionCommandPlan(input: {
  items: CatalogItemServices;
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

async function formatPokemonCardPromotionMetadata(input: {
  deps: CatalogRuntimeDeps;
  normalized: SourceObservationPokemonCardNormalized;
  expansionReferenceId: ReferenceRecordId;
}): Promise<{ title: string; subtitle: string }> {
  void input.deps;
  void input.expansionReferenceId;
  return {
    title: input.normalized.name,
    subtitle: "",
  };
}

function isPromotableObservationStatus(status: string): boolean {
  return status === "observed" || status === "changed" || status === "promoted";
}

function requirePromotionAssetPorts(input: {
  deps: CatalogRuntimeDeps;
  normalized: SourceObservationPokemonCardNormalized;
}) {
  if (input.normalized.imageBaseUrl) {
    requireCatalogAssetStorage(input.deps.assetStorage);
  }
}

function requirePokemonCardPromotionObservation(
  normalized: SourceObservationNormalized,
  providerKey: string,
): SourceObservationPokemonCardNormalized {
  if (!isPokemonCardSourceObservationNormalized(normalized)) {
    throw new Error(
      `Catalog promotion for provider '${providerKey}' requires a Pokemon card source observation. Normalized kind '${normalized.kind}' is not yet promotable.`,
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
  const result = await provisionCatalogProviderReferenceHierarchy({
    profile: input.profile,
    payload: input.normalized as unknown as JsonValue,
    provisioner: {
      ensureReferenceType: (def) => ensureReferenceType(input, def),
      ensureReferenceRecord: (def) => ensureReferenceRecord(input, def),
    },
  });

  return result.targetReferenceRecordId;
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
  return key.startsWith("tcgdex-") || key.startsWith("tcgplayer-") || key.startsWith("scryfall-");
}

async function loadPokemonTcgPromotionProfile(
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
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const profile = await profileVersions.getActiveProfileVersion(providerKey);
  if (
    profile &&
    isActivePromotionProfileVersion(profile) &&
    profile.profile.normalizedObservationMapping.kind === normalized.kind
  ) {
    return profile;
  }

  const compatibleProfile = (await profileVersions.listProfileVersions()).find(
    (candidate) =>
      isActivePromotionProfileVersion(candidate) &&
      candidate.profile.normalizedObservationMapping.kind === normalized.kind,
  );
  if (compatibleProfile) {
    return compatibleProfile;
  }

  if (profile && profile.profile.normalizedObservationMapping.kind !== normalized.kind) {
    throw new Error(
      `Provider '${providerKey}' promotion mapping '${profile.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
    );
  }

  throw new Error(`Provider '${providerKey}' does not support Catalog Item promotion.`);
}

function isActivePromotionProfileVersion(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("catalog-item-promotion")
  );
}

function requireSourceObservationMappingContract(
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

async function defaultSourceObservationImportProviderKey(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
): Promise<string> {
  const profile = (await profileVersions.listProfileVersions()).find(isActiveSourceObservationImportProfileVersion);
  if (!profile) {
    throw new Error("No active Catalog source observation import provider is configured.");
  }

  return profile.providerKey;
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

type ClaimedSourceObservationBulkJob = SourceObservationBulkJob &
  Readonly<{
    eventContext: EventStoreContext;
    claimOwnerId: string;
  }>;

type ClaimedSourceObservationIntegrationJob = SourceObservationIntegrationJob &
  Readonly<{
    eventContext: EventStoreContext;
    claimOwnerId: string;
  }>;

function toSourceObservationBulkJob(
  job: DurableJobRecord<SourceObservationBulkJobPayload, BulkSourceObservationProgress, SourceObservationBulkJobResult>,
): SourceObservationBulkJob {
  return {
    jobId: job.jobId,
    action: job.payload.action,
    selectionMode: job.payload.selectionMode,
    observationIds: job.payload.observationIds,
    scope: normalizeBulkJobScope(job.payload.scope),
    reason: job.payload.reason,
    status: job.status,
    progress: job.progress,
    result: job.result,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function toSourceObservationBulkJobEventSnapshot(
  job: DurableJobRecord<SourceObservationBulkJobPayload, BulkSourceObservationProgress, SourceObservationBulkJobResult>,
): SourceObservationBulkJob {
  const snapshot = toSourceObservationBulkJob(job);
  return snapshot.status === "completed" || snapshot.status === "failed"
    ? snapshot
    : {
        ...snapshot,
        result: null,
      };
}

function toClaimedSourceObservationBulkJob(
  job: DurableJobRecord<SourceObservationBulkJobPayload, BulkSourceObservationProgress, SourceObservationBulkJobResult>,
): ClaimedSourceObservationBulkJob {
  const eventContext = job.eventContext;
  const claimOwnerId = job.claimOwnerId;
  if (!eventContext || !claimOwnerId) {
    throw new Error("Source Observation bulk job is missing claim context.");
  }

  return {
    ...toSourceObservationBulkJob(job),
    eventContext,
    claimOwnerId,
  };
}

function toClaimedSourceObservationBulkJobFromWorkUnitClaim(
  claim: DurableJobWorkUnitClaim<
    SourceObservationBulkJobPayload,
    BulkSourceObservationProgress,
    SourceObservationBulkJobResult,
    SourceObservationBulkWorkUnitPayload,
    SourceObservationBulkWorkUnitResult
  >,
): ClaimedSourceObservationBulkJob {
  const eventContext = claim.job.eventContext;
  if (!eventContext) {
    throw new Error("Source Observation bulk job is missing claim context.");
  }

  return {
    ...toSourceObservationBulkJob(claim.job),
    eventContext,
    claimOwnerId: claim.claimOwnerId,
  };
}

function toSourceObservationIntegrationJob(
  job: DurableJobRecord<
    SourceObservationIntegrationJobPayload,
    BulkSourceObservationProgress,
    SourceObservationIntegrationJobResult
  >,
): SourceObservationIntegrationJob {
  return {
    jobId: job.jobId,
    action: job.payload.action,
    scope: normalizeIntegrationJobScope(job.payload.scope),
    profileSnapshot: job.payload.profileSnapshot ?? null,
    reapplyProfileMode: normalizeReapplyProfileMode(job.payload.reapplyProfileMode),
    status: job.status,
    progress: job.progress,
    result: job.result,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function toSourceObservationIntegrationJobEventSnapshot(
  job: DurableJobRecord<
    SourceObservationIntegrationJobPayload,
    BulkSourceObservationProgress,
    SourceObservationIntegrationJobResult
  >,
): SourceObservationIntegrationJob {
  const snapshot = toSourceObservationIntegrationJob(job);
  return snapshot.status === "completed" || snapshot.status === "failed"
    ? snapshot
    : {
        ...snapshot,
        result: null,
      };
}

function toClaimedSourceObservationIntegrationJob(
  job: DurableJobRecord<
    SourceObservationIntegrationJobPayload,
    BulkSourceObservationProgress,
    SourceObservationIntegrationJobResult
  >,
): ClaimedSourceObservationIntegrationJob {
  const eventContext = job.eventContext;
  const claimOwnerId = job.claimOwnerId;
  if (!eventContext || !claimOwnerId) {
    throw new Error("Source Observation integration job is missing claim context.");
  }

  return {
    ...toSourceObservationIntegrationJob(job),
    eventContext,
    claimOwnerId,
  };
}

function toSourceObservationJobEvent<TJob>(
  event: DurableJobEvent<unknown, BulkSourceObservationProgress, unknown, TJob>,
): SourceObservationJobEvent<TJob> {
  return {
    sequence: event.sequence,
    eventName: event.eventName,
    job: event.job,
    createdAt: event.createdAt,
  };
}

async function requireSourceObservationJobClaim(succeeded: Promise<boolean> | boolean) {
  if (!(await succeeded)) {
    throw new Error("Source Observation job claim was lost before the status update completed.");
  }
}

function sourceObservationRetentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

function jobMatchesContext(
  job: Readonly<{ eventContext: EventStoreContext | null }>,
  context: EventStoreContext,
): boolean {
  return (
    job.eventContext?.tenantId === context.tenantId &&
    job.eventContext?.audit?.forAccountId === context.audit?.forAccountId &&
    job.eventContext?.audit?.performedByUserId === context.audit?.performedByUserId
  );
}

function parseJsonField<T>(value: unknown, fieldName: string): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  if (value && typeof value === "object") {
    return value as T;
  }

  throw new Error(`Bulk review job ${fieldName} is not valid JSON.`);
}

function formatDateLike(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeBulkJobScope(scope: SourceObservationFilterScope): SourceObservationFilterScope {
  return {
    search: scope.search?.trim() || undefined,
    status: scope.status?.trim() || undefined,
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
  };
}

function normalizeIntegrationJobScope(
  scope: SourceObservationIntegrationJobScope,
): SourceObservationIntegrationJobScope {
  return {
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    seriesId: scope.seriesId?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
    productLineId: scope.productLineId?.trim() || undefined,
    setName: scope.setName?.trim() || undefined,
    productId: scope.productId?.trim() || undefined,
  };
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function integrationScopeToObservationScope(scope: SourceObservationIntegrationJobScope): SourceObservationFilterScope {
  return {
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
  };
}

function uniqueObservationIds(observationIds: readonly string[]): string[] {
  return Array.from(
    new Set(
      observationIds.map((observationId) => observationId.trim()).filter((observationId) => observationId.length > 0),
    ),
  );
}

function summarizePromotionOutcomes(
  requested: number,
  outcomes: readonly BulkSourceObservationPromotionOutcome[],
): BulkSourceObservationPromotionResult {
  return {
    requested,
    promoted: outcomes.filter((outcome) => outcome.status === "promoted").length,
    rejected: outcomes.filter((outcome) => outcome.status === "rejected").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}

function summarizeReapplyOutcomes(
  requested: number,
  outcomes: readonly BulkSourceObservationReapplyOutcome[],
): BulkSourceObservationReapplyResult {
  return {
    requested,
    reapplied: outcomes.filter((outcome) => outcome.status === "reapplied").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}

function bulkResultOutcomes(
  result: SourceObservationBulkJobResult | null,
): readonly SourceObservationBulkWorkUnitResult[] {
  return result?.outcomes ?? [];
}

function isPromotionOutcome(
  outcome: SourceObservationBulkWorkUnitResult,
): outcome is BulkSourceObservationPromotionOutcome {
  return (
    outcome.status === "promoted" ||
    outcome.status === "rejected" ||
    outcome.status === "skipped" ||
    outcome.status === "failed"
  );
}

function isReapplyOutcome(
  outcome: SourceObservationBulkWorkUnitResult,
): outcome is BulkSourceObservationReapplyOutcome {
  return outcome.status === "reapplied" || outcome.status === "skipped" || outcome.status === "failed";
}

function workUnitTerminalState(outcome: SourceObservationBulkWorkUnitResult): "completed" | "failed" | "skipped" {
  if (outcome.status === "failed") {
    return "failed";
  }
  if (outcome.status === "skipped") {
    return "skipped";
  }
  return "completed";
}

function failedBulkWorkUnitOutcome(
  action: SourceObservationBulkJobAction,
  observationId: string,
  reason: string,
): SourceObservationBulkWorkUnitResult {
  return action === "reapply"
    ? {
        observationId,
        status: "failed",
        catalogItemId: null,
        reason,
      }
    : {
        observationId,
        status: "failed",
        catalogItemId: null,
        reason,
      };
}

class SourceObservationJobCancelledError extends Error {
  constructor() {
    super("Source Observation job run was cancelled.");
  }
}

function createSourceObservationSideEffectRunner<TResult>(
  jobContext: DurableJobExecutionContext<BulkSourceObservationProgress, TResult>,
): DurableSideEffectRunner {
  return (work) =>
    runDurableJobSideEffect(jobContext, work, {
      renewIntervalMs: 5_000,
      claimLostMessage: "Source Observation job claim was lost while applying a side effect.",
    });
}

function createSourceObservationWorkUnitSideEffectRunner<
  TJobPayload,
  TJobProgress,
  TJobResult,
  TUnitPayload,
  TUnitResult,
>(
  store: DurableJobWorkUnitStore<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult>,
  claim: DurableJobWorkUnitClaim<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult>,
  input: Readonly<{
    claimTtlMs: number;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }>,
): DurableSideEffectRunner {
  return async (work) => {
    const abortController = new AbortController();
    const abortFromParent = () => abortController.abort();
    if (input.signal?.aborted) {
      abortController.abort();
    } else {
      input.signal?.addEventListener("abort", abortFromParent, { once: true });
    }

    let claimActive = true;
    const renewIntervalMs = Math.max(1_000, Math.floor(input.claimTtlMs / 3));
    const renewalTimer = setInterval(() => {
      try {
        input.throwIfLeaseLost?.();
      } catch {
        claimActive = false;
        abortController.abort();
        return;
      }

      void store
        .renewClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          claimTtlMs: input.claimTtlMs,
        })
        .then((renewed) => {
          claimActive = claimActive && renewed;
          if (!renewed) {
            abortController.abort();
          }
        })
        .catch(() => {
          claimActive = false;
          abortController.abort();
        });
    }, renewIntervalMs);
    renewalTimer.unref?.();

    try {
      if (!claimActive || abortController.signal.aborted) {
        throw new DurableJobHandoffError("Source Observation work unit claim was lost.");
      }
      const result = await work(abortController.signal);
      if (!claimActive || abortController.signal.aborted) {
        throw new DurableJobHandoffError("Source Observation work unit claim was lost.");
      }
      return result;
    } finally {
      clearInterval(renewalTimer);
      input.signal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function runSourceObservationSideEffectImmediately<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return work(new AbortController().signal);
}

function isJobRunCancelled(context: SourceObservationJobRunContext): boolean {
  return context.signal?.aborted ?? false;
}

function throwIfJobRunCancelled(context: SourceObservationJobRunContext): void {
  if (context.signal?.aborted) {
    throw new SourceObservationJobCancelledError();
  }

  try {
    context.throwIfLeaseLost?.();
  } catch (error) {
    throw new SourceObservationJobCancelledError();
  }
}

function summarizeIntegrationJobOutcomes(
  requested: number,
  outcomes: readonly SourceObservationIntegrationJobOutcome[],
): SourceObservationIntegrationJobResult {
  return {
    requested,
    imported: outcomes.filter((outcome) => outcome.status === "imported").length,
    observed: outcomes.reduce((total, outcome) => total + outcome.observed, 0),
    reapplied: outcomes.reduce((total, outcome) => total + outcome.reapplied, 0),
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}

function integrationReapplyOutcomeFromBulkOutcome(
  job: SourceObservationIntegrationJob,
  observationId: string,
  outcome: BulkSourceObservationReapplyOutcome | undefined,
  defaultProviderKey: string,
): SourceObservationIntegrationJobOutcome {
  return {
    providerKey: job.scope.provider || defaultProviderKey,
    languageCode: job.scope.language || "",
    expansionId: observationId,
    status: outcome?.status ?? "failed",
    observed: 0,
    reapplied: outcome?.status === "reapplied" ? 1 : 0,
    reason: outcome?.reason ?? (outcome ? null : "No reapply outcome."),
  };
}

function bulkProgress(
  completed: number,
  total: number,
  currentName: string | null = null,
  status: BulkSourceObservationProgress["status"] = null,
  phase: BulkSourceObservationProgress["phase"] = "processing",
): BulkSourceObservationProgress {
  return {
    phase,
    completed,
    total,
    currentName,
    status,
  };
}
