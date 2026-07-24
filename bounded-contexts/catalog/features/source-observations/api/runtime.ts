import { createHash } from "node:crypto";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
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
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  type DurableJobStatus,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  isDurableJobWorkUnitTerminalAccepted,
  type DurableJobWorkUnitClaim,
  type DurableJobWorkUnitTerminalOutcome,
  type DurableJobWorkUnitStore,
  type DurableJobWorkUnitRecord,
  type DurableJobWorkUnitSummary,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { toJsonValue, type JsonValue } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
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
  type CatalogScopeSyncScopeDescriptor,
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
  type SourceObservationCommand,
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
  type SourceObservationState,
} from "../domain/domain";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateCommand,
  type CatalogMergeCandidateConflictResolution,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidateReviewActor,
  type CatalogMergeCandidateReviewSnapshot,
  type CatalogMergeCandidateState,
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
  type SourceObservationIntegrationScopeRow,
  type SourceObservationListRow,
  type SourceObservationPromotionPreview,
  type SourceObservationReapplyPreview,
} from "../read-model/queries";
import {
  buildCatalogMergeCandidatesFromObservations,
  type CatalogMergeCandidateMatchBatch,
  type CatalogMergeCandidateMatchExclusion,
  type CatalogMergeCandidateMatchResult,
} from "./catalog-merge-candidate-matcher";
import {
  listAcceptedProviderScopeMappingsByScopeRecord,
  listAcceptedProviderScopeMappingsForProviders,
} from "../../provider-scope-mapping/read-model/queries";
import {
  planCatalogMergeCandidatePromotionCommands,
  type CatalogMergeCandidatePromotionCommandPlanResult,
  type CatalogMergeCandidatePromotionCandidate,
  type CatalogMergeCandidatePromotionCatalogMapping,
  type CatalogMergeCandidatePromotionAssetPlan,
} from "./catalog-merge-candidate-promotion-planner";
import {
  normalizeTcgdexImageAsset,
  type TcgdexExpansionOption,
  type TcgdexLanguageOption,
  type TcgdexObservationPayload,
  type TcgdexSeriesOption,
} from "./tcgdex-client";
import {
  extractApprovedLorcanaImageEvidence,
  normalizeLorcanaImageAsset,
  normalizeProductAssetSet,
} from "./product-asset-normalization";
import { ingestTcgdexAliasCandidates } from "./tcgdex-alias-intake";
import { upsertSourceObservationAliasCandidates } from "../../alias-equivalence/read-model/projection";
import type { CatalogAliasCandidate } from "../../alias-equivalence/domain/alias";
import { writePromotionAliases, type PromotionAliasServices } from "./provider-promotion-alias-writer";
import { createPromotionAliasReader } from "./provider-promotion-alias-reader";
import type { PromotionAliasTargetResolution } from "./provider-promotion-alias-planner";
import {
  buildTcgplayerAutomationSourceObservationPayload,
  type TcgplayerAutomationCatalogClient,
  type TcgplayerAutomationProductDetail,
} from "./tcgplayer-automation-catalog-client";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  getActiveCatalogProviderIntegrationProfileVersion,
  getCatalogProviderIntegrationProfileVersion,
  listCatalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  catalogProviderSourceMappingFingerprint,
  normalizeCatalogProviderSourceObservation,
  requireCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import {
  createCatalogIntegrationDryRunProofRegistry,
  type CatalogIntegrationDryRunProofRegistry,
} from "./catalog-integration-dry-run-proofs";
import {
  catalogProviderCredentialReadinessToTransportDiagnostic,
  type CatalogProviderCredentialReadiness,
  type CatalogProviderCredentialRequirement,
  type CatalogProviderCredentialReadinessState,
} from "./catalog-integration-credential-readiness";
import {
  CatalogIntegrationRolloutControlError,
  createCatalogIntegrationRolloutControlPolicyFromEnv,
  type CatalogIntegrationRolloutControlPolicy,
  type CatalogIntegrationRolloutControlSnapshot,
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
import {
  createReferenceCardsProviderAdapter,
  REFERENCE_CARDS_PROFILE_VERSION,
} from "./provider-adapters/reference-cards";
import {
  createTcgdexProviderAdapter,
  TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./provider-adapters/tcgdex";
import {
  createTcgplayerProviderAdapter,
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  type TcgplayerProviderPayload,
} from "./provider-adapters/tcgplayer";
import {
  createMtgjsonProviderAdapter,
  MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type MtgjsonProviderPayload,
} from "./provider-adapters/mtgjson";
import {
  createLorcanajsonProviderAdapter,
  LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type LorcanajsonProviderPayload,
} from "./provider-adapters/lorcanajson";
import {
  createLorcastProviderAdapter,
  LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type LorcastProviderPayload,
} from "./provider-adapters/lorcast";
import {
  createScryfallProviderAdapter,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type ScryfallProviderPayload,
} from "./provider-adapters/scryfall";
import {
  createYgoprodeckProviderAdapter,
  YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type YgoprodeckProviderPayload,
} from "./provider-adapters/ygoprodeck";
import {
  createYgojsonProviderAdapter,
  YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
  YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  type YgojsonProviderPayload,
} from "./provider-adapters/ygojson";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  type ScrydexOnePieceCredentials,
  type ScrydexOnePieceProviderPayload,
} from "./provider-adapters/scrydex-one-piece";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderOptionAlias,
  ProviderPayloadEnvelope,
  ProviderTransportDiagnostic,
  ProviderUsageEstimate,
} from "./provider-adapters/provider-adapter";
import {
  listCatalogProviderIntegrationOptionsFromProfiles,
  type CatalogProviderIntegrationOption,
} from "./provider-option-query-resolver";
import type { ProviderOptionAliasRecord } from "./provider-option-aliases";
import {
  createPgCatalogProviderOptionQueryCacheStore,
  queryCatalogProviderIntegrationOptionsWithCache,
  type CatalogProviderOptionQueryPage,
} from "./provider-option-query-cache";
import {
  normalizeCatalogControlPlaneTelemetryEvent,
  type CatalogControlPlaneTelemetryEventInput,
  type SourceObservationTelemetry,
} from "./catalog-integration-observability";
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

function catalogProviderProfileVersionLookupKey(
  providerKey: string,
  profileKey: string,
  profileVersion: string,
): string {
  return `${providerKey.trim().toLowerCase()}\u0000${profileKey.trim().toLowerCase()}\u0000${profileVersion.trim()}`;
}

const staticCatalogProviderIntegrationProfileVersions: CatalogProviderIntegrationProfileVersionReader = {
  listProfileVersions: async (providerKey?: string | null) => {
    const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
    const versions = listCatalogProviderIntegrationProfileVersions();
    return normalizedProviderKey
      ? versions.filter((version) => version.providerKey.trim().toLowerCase() === normalizedProviderKey)
      : versions;
  },
  getActiveProfileVersion: async (providerKey: string, selector?: CatalogProviderProfileVersionSelector | null) =>
    getActiveCatalogProviderIntegrationProfileVersion(providerKey, selector),
};

export type BulkSourceObservationPromotionOutcome = Readonly<{
  observationId: string;
  status: "promoted" | "rejected" | "deferred" | "skipped" | "failed";
  catalogItemId: CatalogItemId | null;
  referenceRecordId?: ReferenceRecordId | null;
  reason: string | null;
}>;

export type BulkSourceObservationPromotionResult = Readonly<{
  requested: number;
  promoted: number;
  rejected?: number;
  deferred?: number;
  skipped: number;
  failed: number;
  outcomes: readonly BulkSourceObservationPromotionOutcome[];
}>;

export type BulkSourceObservationReapplyOutcome = Readonly<{
  observationId: string;
  status: "reapplied" | "skipped" | "failed";
  catalogItemId: CatalogItemId | null;
  referenceRecordId?: ReferenceRecordId | null;
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

export type SourceObservationBulkJobAction = "promote" | "reject" | "defer" | "reapply";

export type SourceObservationBulkJobStatus = "queued" | "running" | "completed" | "failed";

type SourceObservationBulkJobPayload = Readonly<{
  action: SourceObservationBulkJobAction;
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: SourceObservationFilterScope;
  reason: string | null;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

type SourceObservationBulkWorkUnitPayload = Readonly<{
  observationId: string;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

type SourceObservationBulkWorkUnitResult = BulkSourceObservationPromotionOutcome | BulkSourceObservationReapplyOutcome;

export type SourceObservationBulkJob = Readonly<{
  jobId: string;
  action: SourceObservationBulkJobAction;
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: SourceObservationFilterScope;
  reason: string | null;
  profileSnapshot: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode: SourceObservationReapplyProfileMode | null;
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

export type SourceObservationPromotionOutcomeRecord = Readonly<{
  outcomeId: string;
  jobId: string;
  eventSequence: number;
  terminalState: "completed" | "partial" | "failed";
  requested: number;
  promoted: number;
  skipped: number;
  failed: number;
  outcomes: readonly BulkSourceObservationPromotionOutcome[];
  errorMessage: string | null;
  recordedAt: string;
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
  profileKey?: string;
  ingestionUnitKey?: string;
  language?: string;
  seriesId?: string;
  setId?: string;
  productLineId?: string;
  setName?: string;
  productId?: string;
  planningFingerprint?: string;
}>;

export type RepresentativeCatalogProductAssetSource = Readonly<{
  body: Uint8Array;
  contentType: string;
  sourceUrl: string | null;
  sourceHash: string;
}>;

type SourceObservationIntegrationJobPayload = Readonly<{
  action: SourceObservationIntegrationJobAction;
  scope: SourceObservationIntegrationJobScope;
  syncRunId?: string | null;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

export type SourceObservationIntegrationProfileSnapshot = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  ingestionUnitKey?: string | null;
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
  connectorKind: string;
  connectorSourceVersion: string | null;
  sourceMappingFingerprint: string;
}>;

type SourceObservationIntegrationWorkUnitPayload = Readonly<{
  observationId: string;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

type ProviderAdapterIntegrationImportTarget = Readonly<{
  targetId: string;
  name: string;
  scopeKey: string;
  values: Readonly<Record<string, string>>;
  languageCode: string;
}>;

type ProviderIntegrationImportTargetOptionScope = "expansion" | "set-name";

type ProviderAdapterImportProgress = Readonly<{
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
  providerUsageEvidence?: SourceObservationProviderUsageEvidence | null;
}>;

export type SourceObservationProviderUsageEvidence = Readonly<{
  unitKey: string;
  requestStrategy: ProviderUsageEstimate["requestStrategy"];
  estimateState: ProviderUsageEstimate["estimateState"];
  estimatedRequestCount: number | null;
  estimateReason: string | null;
  actualRequestCount: number | null;
  /**
   * For bulk-first imports, the number of distinct response-page source URLs.
   * Each observed page URL is also one provider request, so this intentionally
   * aliases actualRequestCount instead of claiming an independent measurement.
   */
  pageCount: number | null;
  /** Unavailable until the import fetch path emits an observed cache outcome. */
  cacheHitCount: number | null;
  /** Unavailable until the import fetch path emits an observed cache outcome. */
  cacheMissCount: number | null;
  usageCheckState: ProviderUsageEstimate["usageCheckState"];
  creditDiagnostic: string | null;
  degradedDiagnostic: string | null;
  bulkFirstConfirmed: boolean | null;
  perRecordFallbackReason: string | null;
  selectedFields: readonly string[];
  pageSize: number | null;
}>;

export type SourceObservationIntegrationImportPreviewTarget = Readonly<{
  targetId: string;
  name: string;
  languageCode: string;
  scopeKey: string;
  planKey: string;
  estimatedPayloads: number | null;
  transportSteps: readonly string[];
  usageEstimate: ProviderUsageEstimate | null;
}>;

export type SourceObservationIntegrationImportPreview = Readonly<{
  action: "import";
  providerKey: string;
  scope: SourceObservationIntegrationJobScope;
  profileSnapshot: SourceObservationIntegrationProfileSnapshot | null;
  targetCount: number;
  targets: readonly SourceObservationIntegrationImportPreviewTarget[];
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

type SourceObservationIntegrationDurableJobRecord = DurableJobRecord<
  SourceObservationIntegrationJobPayload,
  BulkSourceObservationProgress,
  SourceObservationIntegrationJobResult
>;

type CatalogSyncRunPayload = Readonly<{
  runVersion: "catalog-sync-run-v1";
  idempotencyKey: string;
  scope: CatalogSyncScope;
  selectedUnits: readonly CatalogSyncRunSelectedUnitSnapshot[];
  preview: CatalogSyncProviderParticipationPreview;
}>;

type CatalogSyncRunFanoutProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentName: string | null;
  status: "child-job-enqueued" | "child-job-failed" | null;
}>;

type CatalogSyncRunFanoutResult = Readonly<{
  childJobs: readonly CatalogSyncRunChildJobLink[];
}>;

type CatalogSyncRunDurableJobRecord = DurableJobRecord<
  CatalogSyncRunPayload,
  CatalogSyncRunFanoutProgress,
  CatalogSyncRunFanoutResult
>;

export type SourceObservationIntegrationJobOperatorStatus =
  | "queued"
  | "running"
  | "stale"
  | "retried"
  | "partial"
  | "failed"
  | "cancelled"
  | "completed";

export type SourceObservationIntegrationJobLifecycleCommandErrorCode =
  | "job_not_found"
  | "unsupported_action"
  | "unsupported_state";

export class SourceObservationIntegrationJobLifecycleCommandError extends Error {
  public readonly code: SourceObservationIntegrationJobLifecycleCommandErrorCode;

  constructor(code: SourceObservationIntegrationJobLifecycleCommandErrorCode, message: string) {
    super(message);
    this.name = "SourceObservationIntegrationJobLifecycleCommandError";
    this.code = code;
  }
}

export function isSourceObservationIntegrationJobLifecycleCommandError(
  error: unknown,
): error is SourceObservationIntegrationJobLifecycleCommandError {
  return error instanceof SourceObservationIntegrationJobLifecycleCommandError;
}

const OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE = "Operator cancelled provider import job.";

export type SourceObservationIntegrationJobConsistency = Readonly<{
  duplicateSubmissionPolicy: "reuse-active-job";
  profileSnapshotPolicy: "snapshotted-at-enqueue";
  retryResumePolicy: "skip-completed-outcomes";
  partialFailurePolicy: "mixed-outcomes";
  workUnitClaimPolicy: "leased-job-turns" | "leased-work-units";
}>;

export type SourceObservationIntegrationJob = Readonly<{
  jobId: string;
  syncRunId: string | null;
  action: SourceObservationIntegrationJobAction;
  scope: SourceObservationIntegrationJobScope;
  profileSnapshot: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode: SourceObservationReapplyProfileMode | null;
  status: SourceObservationBulkJobStatus;
  operatorStatus: SourceObservationIntegrationJobOperatorStatus;
  consistency: SourceObservationIntegrationJobConsistency;
  progress: BulkSourceObservationProgress;
  result: SourceObservationIntegrationJobResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type CatalogSyncRunChildStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "stale"
  | "retried"
  | "reused-active-job";

export type CatalogSyncRunOperatorStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

export type CatalogSyncRunSelectedUnitSnapshot = Readonly<{
  providerKey: string;
  unitKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  role: CatalogSyncProviderParticipationPreview["units"][number]["role"];
  requirement: CatalogSyncProviderParticipationPreview["units"][number]["requirement"];
  childExecutionScope: SourceObservationIntegrationJobScope;
}>;

export type CatalogSyncRunChildJobLink = Readonly<{
  providerKey: string;
  unitKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  childExecutionScope: SourceObservationIntegrationJobScope;
  childJobId: string | null;
  // "reused-settled-child-job": the durable per-scope sync state showed this
  // unit already settled with an unchanged child execution scope, so the
  // fan-out skipped a new provider call and pointed the child link at the
  // prior completed job — the "Sync scope on a settled scope is a fast
  // no-op" behavior.
  syncRunLinkState:
    | "attached-to-child-payload"
    | "reused-active-child-job"
    | "reused-settled-child-job"
    | "child-enqueue-failed";
  errorMessage: string | null;
}>;

export type CatalogSyncRunChildJob = CatalogSyncRunChildJobLink &
  Readonly<{
    status: CatalogSyncRunChildStatus;
    job: SourceObservationIntegrationJob | null;
  }>;

export type CatalogSyncRunProgress = Readonly<{
  childJobs: Readonly<{
    total: number;
    queued: number;
    running: number;
    completed: number;
    partial: number;
    failed: number;
    cancelled: number;
    stale: number;
  }>;
  providerTargets: Readonly<{
    completed: number;
    total: number;
  }>;
}>;

export type CatalogSyncRunConsistency = Readonly<{
  duplicateSubmissionPolicy: "reuse-active-sync-run";
  childScopePolicy: "deterministic-from-provider-participation-preview";
  profileSnapshotPolicy: "selected-active-provider-units-snapshotted-at-enqueue";
  childRetryResumeCancelPolicy: "delegated-to-provider-import-jobs";
  partialFailurePolicy: "visible-per-provider-child-job";
}>;

export type CatalogSyncRun = Readonly<{
  syncRunId: string;
  scope: CatalogSyncScope;
  status: CatalogSyncRunOperatorStatus;
  progress: CatalogSyncRunProgress;
  selectedUnits: readonly CatalogSyncRunSelectedUnitSnapshot[];
  childJobs: readonly CatalogSyncRunChildJob[];
  consistency: CatalogSyncRunConsistency;
  preview: CatalogSyncProviderParticipationPreview;
  errorMessage: string | null;
  createdAt: string;
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
  aliases: readonly ProviderOptionAliasRecord[];
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
  rolloutControls: CatalogIntegrationRolloutControlSnapshot;
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
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: CatalogProviderCredentialReadinessState;
  credentialRequirement: CatalogProviderCredentialRequirement;
  credentialDiagnosticCode: string | null;
  transportReadiness: "ready" | "blocked";
  fixtureValidationStatus: "ready" | "blocked";
  dryRunStatus: "completed" | "blocked";
  observationFacts: number;
  diagnosticCounts: Readonly<{
    info: number;
    warning: number;
    error: number;
  }>;
  diagnostics: readonly CatalogIntegrationControlPlaneDiagnostic[];
  latestDiagnosticText: string | null;
  dryRunEvidence: readonly CatalogIntegrationControlPlaneDryRunEvidence[];
}>;

export type CatalogIntegrationControlPlaneDiagnostic = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  unitKey: string | null;
  retryAfterSeconds: number | null;
  source: "catalog" | "provider-adapter";
}>;

export type CatalogIntegrationControlPlaneDryRunEvidence = Readonly<{
  externalKey: string;
  sourceUrl: string | null;
  sourceHash: string | null;
  normalizedFacts: Readonly<Record<string, string>>;
}>;

export type SourceObservationCommandServices = Readonly<{
  commandHandler: CommandHandler<SourceObservationCommand, SourceObservationState, SourceObservationEvent>;
}>;

export type ProviderAdapterServices = Readonly<{
  providerAdapterRegistry: ProviderAdapterRegistry;
}>;

export type ProviderOptionQueryServices = Readonly<{
  listTcgdexLanguages: () => Promise<readonly TcgdexLanguageOption[]>;
  listTcgdexSeries: (input: { languageCode: string }) => Promise<readonly TcgdexSeriesOption[]>;
  listTcgdexExpansions: (input: {
    languageCode: string;
    seriesId?: string | null;
  }) => Promise<readonly TcgdexExpansionOption[]>;
  queryIntegrationOptions: (input: {
    providerKey: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
    cursor?: string | null;
    limit?: number | null;
    forceRefresh?: boolean | null;
    cacheOnly?: boolean | null;
  }) => Promise<CatalogProviderOptionQueryPage>;
  listIntegrationOptions: (input: {
    providerKey: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
  }) => Promise<readonly SourceObservationIntegrationOption[]>;
}>;

export type ProviderProfileAdminServices = Readonly<{
  getSelectedOptionAuthoringSchema: () => Promise<SourceObservationSelectedOptionAuthoringSchema>;
  getPromotionTargetAuthoringSchema: () => Promise<SourceObservationPromotionTargetAuthoringSchema>;
}>;

export type CatalogIntegrationEngineServices = Readonly<{
  previewDuplicatePreventionCandidates: (input: {
    providerKey: string;
    profileVersion: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    payload: JsonValue;
    observedAt?: string;
  }) => Promise<SourceObservationDuplicatePreventionCandidatePreview>;
  previewReplayReapplyImpact: (input: {
    providerKey: string;
    profileVersion: string;
    scope: SourceObservationFilterScope;
    context?: EventStoreContext | null;
  }) => Promise<CatalogAdminReplayReapplyImpactSummaryReadModel>;
  previewProviderProfileLifecycleImpact: (input: {
    providerKey: string;
    profileVersion: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    operation: CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];
    context?: EventStoreContext | null;
  }) => Promise<CatalogAdminRollbackRetirementImpactSummaryReadModel>;
  getCatalogIntegrationControlPlaneReadiness: () => Promise<CatalogIntegrationControlPlaneReadiness>;
  getCatalogIntegrationRolloutControls: () => CatalogIntegrationRolloutControlSnapshot;
  assertCatalogIntegrationRolloutAllowed: CatalogIntegrationRolloutControlPolicy["assertAllowed"];
  importProviderAdapterForReplay: (input: {
    adapter: ProviderAdapter;
    profileVersion: CatalogProviderIntegrationProfileVersionRecord;
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }) => Promise<readonly SourceObservationIntegrationJobOutcome[]>;
  reconcilePromotedObservationForReplay: (input: {
    observationId: string;
    context: EventStoreContext;
    productAssetSource: RepresentativeCatalogProductAssetSource;
  }) => Promise<
    Readonly<{
      catalogItemId: CatalogItemId;
      promotionProfileKey: string;
      promotionProfileVersion: string;
      promotionPlanFingerprints: readonly string[];
    }>
  >;
}>;

export type SourceObservationReviewServices = Readonly<{
  promoteObservation: (input: {
    observationId: string;
    context: EventStoreContext;
    productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  }) => Promise<SourceObservationPromotionTargetResult>;
  rejectObservation: (input: {
    observationId: string;
    reason: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; status: "rejected" }>;
}>;

type SourceObservationPromotionTargetResult = Readonly<{
  observationId: string;
  catalogItemId: CatalogItemId | null;
  referenceRecordId?: ReferenceRecordId | null;
}>;

export type PromotionReapplyServices = Readonly<{
  promoteObservations: (input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationPromotionResult>;
  previewPromoteObservations: (input: {
    observationIds: readonly string[];
  }) => Promise<SourceObservationPromotionPreview>;
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
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
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
  deferObservations: (input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationPromotionResult>;
  deferObservationScope: (input: {
    scope: SourceObservationFilterScope;
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
  }) => Promise<BulkSourceObservationPromotionResult>;
}>;

export type BulkReviewJobServices = Readonly<{
  enqueueBulkReviewJob: (input: {
    action: SourceObservationBulkJobAction;
    observationIds?: readonly string[];
    scope?: SourceObservationFilterScope;
    reason?: string | null;
    reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
    context: EventStoreContext;
  }) => Promise<SourceObservationBulkJob>;
  getBulkReviewJob: (jobId: string, context?: EventStoreContext | null) => Promise<SourceObservationBulkJob | null>;
  listBulkReviewJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<readonly SourceObservationJobEvent<SourceObservationBulkJob>[]>;
  getBulkReviewPromotionOutcome: (jobId: string) => Promise<SourceObservationPromotionOutcomeRecord | null>;
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
}>;

// One provider unit's durable sync state within a Catalog sync scope, read
// back across runs. This is what the scope page renders instead of the
// transient per-run child-job list: state survives after the run that
// produced it is gone, so a failed provider can be retried (via
// `lastJobId` + the existing `retryIntegrationJob`) without re-running the
// whole scope, and a settled provider stays visibly settled until something
// changes.
export type CatalogScopeSyncUnitStateReadModel = Readonly<{
  providerKey: string;
  unitKey: string;
  displayName: string;
  role: string;
  requirement: string;
  state: CatalogScopeSyncUnitState;
  lastSyncRunId: string | null;
  lastJobId: string | null;
  lastOperatorStatus: string | null;
  observedCount: number | null;
  changedCount: number | null;
  requestedCount: number | null;
  failedCount: number | null;
  errorMessage: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  updatedAt: string;
}>;

export type IntegrationJobServices = Readonly<{
  previewCatalogSyncScope: (input: {
    scope: CatalogSyncScope;
    context: EventStoreContext;
    includeOperationalGates?: boolean;
    acceptedScopeMappings?: readonly CatalogSyncAcceptedScopeMapping[];
  }) => Promise<CatalogSyncProviderParticipationPreview>;
  enqueueCatalogSyncRun: (input: { scope: CatalogSyncScope; context: EventStoreContext }) => Promise<CatalogSyncRun>;
  getCatalogSyncRun: (input: { syncRunId: string; context: EventStoreContext }) => Promise<CatalogSyncRun | null>;
  getCatalogScopeSyncState: (input: {
    scope: CatalogSyncScope;
    context: EventStoreContext;
  }) => Promise<readonly CatalogScopeSyncUnitStateReadModel[]>;
  previewIntegrationImport: (input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }) => Promise<SourceObservationIntegrationImportPreview>;
  enqueueIntegrationJob: (input: {
    action: SourceObservationIntegrationJobAction;
    scope: SourceObservationIntegrationJobScope;
    syncRunId?: string | null;
    reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
    context: EventStoreContext;
  }) => Promise<SourceObservationIntegrationJob>;
  retryIntegrationJob: (input: {
    jobId: string;
    context: EventStoreContext;
  }) => Promise<SourceObservationIntegrationJob>;
  resumeIntegrationJob: (input: {
    jobId: string;
    context: EventStoreContext;
  }) => Promise<SourceObservationIntegrationJob>;
  cancelIntegrationJob: (input: {
    jobId: string;
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
  listRecentIntegrationJobs: (input: {
    context?: EventStoreContext | null;
    limit?: number;
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
}>;

export type SourceObservationReadServices = Readonly<{
  listSourceObservations: (
    params?: Parameters<typeof listSourceObservations>[1],
  ) => ReturnType<typeof listSourceObservations>;
  listCatalogMergeCandidates: (
    params?: Parameters<typeof listCatalogMergeCandidates>[1],
  ) => ReturnType<typeof listCatalogMergeCandidates>;
  listIntegrationScopes: (params?: {
    provider?: string;
    language?: string;
    productLineId?: string;
    seriesId?: string;
    expansionId?: string;
    setId?: string;
  }) => Promise<readonly SourceObservationIntegrationScopeRow[]>;
  getSourceObservationDetail: (observationId: string) => ReturnType<typeof getSourceObservationDetail>;
}>;

export type CatalogMergeCandidateGenerationResult = Readonly<{
  syncRunId: string | null;
  scope: SourceObservationFilterScope;
  observationCount: number;
  matchedObservationCount: number;
  excludedObservationCount: number;
  candidateCount: number;
  candidates: readonly CatalogMergeCandidateMatchResult[];
  exclusions: readonly CatalogMergeCandidateMatchExclusion[];
}>;

export type CatalogMergeCandidateActionResult = Readonly<{
  candidateId: string;
  action: "promote" | "split" | "update" | "ignore" | "defer";
  version: number;
  status: CatalogMergeCandidateState["status"];
  statusReason: string | null;
  snapshot: CatalogMergeCandidateReviewSnapshot | null;
  splitCandidate?: Readonly<{
    candidateId: string;
    version: number;
    status: CatalogMergeCandidateState["status"];
    statusReason: string | null;
    snapshot: CatalogMergeCandidateReviewSnapshot | null;
  }>;
}>;

export type CatalogMergeCandidateServices = Readonly<{
  generateCatalogMergeCandidates: (input: {
    syncRunId?: string | null;
    scope?: SourceObservationFilterScope;
    context: EventStoreContext;
  }) => Promise<CatalogMergeCandidateGenerationResult>;
  promoteCatalogMergeCandidate: (input: {
    candidateId: string;
    reason: string;
    conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
    context: EventStoreContext;
  }) => Promise<CatalogMergeCandidateActionResult>;
  splitCatalogMergeCandidate: (input: {
    candidateId: string;
    remainingSnapshot: CatalogMergeCandidateReviewSnapshot;
    splitCandidateId: string;
    splitSnapshot: CatalogMergeCandidateReviewSnapshot;
    reason: string;
    conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
    context: EventStoreContext;
  }) => Promise<CatalogMergeCandidateActionResult>;
  updateCatalogMergeCandidate: (input: {
    candidateId: string;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    reason: string;
    conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
    context: EventStoreContext;
  }) => Promise<CatalogMergeCandidateActionResult>;
  ignoreCatalogMergeCandidate: (input: {
    candidateId: string;
    reason: string;
    conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
    context: EventStoreContext;
  }) => Promise<CatalogMergeCandidateActionResult>;
  deferCatalogMergeCandidate: (input: {
    candidateId: string;
    reason: string;
    conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
    context: EventStoreContext;
  }) => Promise<CatalogMergeCandidateActionResult>;
  previewCatalogMergeCandidatePromotionPlan: (input: {
    candidate: CatalogMergeCandidatePromotionCandidate;
    catalog: CatalogMergeCandidatePromotionCatalogMapping;
    createCatalogItemId?: CatalogItemId | null;
    assetPlan?: CatalogMergeCandidatePromotionAssetPlan | null;
  }) => CatalogMergeCandidatePromotionCommandPlanResult;
}>;

export type ControlPlaneTelemetryServices = Readonly<{
  recordControlPlaneTelemetry: (event: CatalogControlPlaneTelemetryEventInput) => void;
}>;

export type SourceObservationRetentionServices = Readonly<{
  pruneSourceObservationJobRetention: (input?: {
    completedBefore?: string | Date;
    limit?: number;
  }) => Promise<{ bulkReviewJobs: number; integrationJobs: number }>;
}>;

export type SourceObservationProjectorServices = Readonly<{
  projectors: readonly ProjectionHandlerSet[];
}>;

export type SourceObservationServices = SourceObservationCommandServices &
  ProviderAdapterServices &
  ProviderOptionQueryServices &
  ProviderProfileAdminServices &
  CatalogIntegrationEngineServices &
  SourceObservationReviewServices &
  PromotionReapplyServices &
  BulkReviewJobServices &
  IntegrationJobServices &
  SourceObservationReadServices &
  CatalogMergeCandidateServices &
  ControlPlaneTelemetryServices &
  SourceObservationRetentionServices &
  SourceObservationProjectorServices;

/**
 * Persistence sink for alias candidates produced during Source Observation
 * intake. Injected from the composition root so the source
 * observation runtime stays decoupled from the alias-equivalence runtime;
 * defaults to the read-model upsert keyed off the shared `deps.db`.
 */
export type SourceObservationAliasCandidateSink = (
  candidates: readonly CatalogAliasCandidate[],
  observedAt: string,
) => Promise<void>;

/**
 * Drives accepted-alias writes and retractions during promotion/reapply.
 * Injected from the composition root so the source observation runtime
 * stays decoupled from the alias-equivalence aggregate. The reader defaults to
 * the read-model over the shared `deps.db`; only the alias command handler
 * (owned by the alias runtime) must be supplied. When omitted, promotion writes
 * no alias facts so minimal/legacy callers are unaffected.
 */
export type SourceObservationAliasPromotion =
  | PromotionAliasServices
  | Readonly<{ catalogAliasCommandHandler: PromotionAliasServices["catalogAliasCommandHandler"] }>;

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

function recordIntegrationJobTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  jobKind: SourceObservationIntegrationJobAction,
  result: "completed" | "failed" | "skipped" | "cancelled" | "released" | "reconciled",
): void {
  telemetry?.recordIntegrationJob?.({ jobKind, result });
}

function recordBulkReviewWorkUnitTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  jobKind: SourceObservationBulkJobAction,
  result: "completed" | "failed" | "skipped" | "cancelled" | "released" | "reconciled",
): void {
  telemetry?.recordBulkReviewWorkUnit?.({ jobKind, result });
}

function recordIntegrationJobControlPlaneTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  job: ClaimedSourceObservationIntegrationJob,
  result: SourceObservationIntegrationJobResult | null,
  fallbackResult?: "failed",
): void {
  if (job.action !== "import") {
    return;
  }

  const failed = fallbackResult === "failed" || (result?.failed ?? 0) > 0;
  telemetry?.recordControlPlaneEvent?.(
    normalizeCatalogControlPlaneTelemetryEvent({
      eventName: failed ? "catalog_control_plane.import_failed" : "catalog_control_plane.import_completed",
      providerKey: job.scope.provider ?? job.profileSnapshot?.providerKey ?? null,
      scopeId: integrationScopeTelemetryRef(job.scope),
      profileRef: integrationProfileTelemetryRef(job.profileSnapshot),
      jobRefState: "present",
      observationStatus: result ? "mixed" : "unknown",
      observationCount: result?.observed ?? result?.imported ?? null,
      promotionResult: failed ? "failed" : "completed",
      blockerCategory: failed ? "provider-transport" : null,
      roleBucket: "unknown",
    }),
  );
}

function recordBulkReviewControlPlaneTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  job: ClaimedSourceObservationBulkJob,
  outcome: SourceObservationBulkWorkUnitResult,
): void {
  if (job.action !== "promote") {
    return;
  }

  const failed = outcome.status === "failed";
  telemetry?.recordControlPlaneEvent?.(
    normalizeCatalogControlPlaneTelemetryEvent({
      eventName: failed ? "catalog_control_plane.promotion_failed" : "catalog_control_plane.promotion_completed",
      providerKey: job.scope.provider ?? null,
      scopeId: promotionScopeTelemetryRef(job.scope),
      jobRefState: "present",
      observationStatus: failed ? "unknown" : "promoted",
      observationCount: 1,
      promotionResult: failed ? "failed" : "completed",
      promotionCount: failed ? 0 : 1,
      blockerCategory: failed ? "promotion-conflict" : null,
      roleBucket: "unknown",
    }),
  );
}

function sourceObservationIntegrationJobTelemetryResult(
  result: SourceObservationIntegrationJobResult,
): "completed" | "failed" | "skipped" {
  if (result.failed > 0) {
    return "failed";
  }
  if (result.skipped > 0 && result.observed === 0 && result.reapplied === 0) {
    return "skipped";
  }
  return "completed";
}

function integrationScopeTelemetryRef(scope: SourceObservationIntegrationJobScope): string | null {
  const segments = [scope.language, scope.productLineId, scope.seriesId, scope.setId, scope.productId].filter(
    (segment): segment is string => Boolean(segment),
  );

  return segments.length > 0 ? segments.join(":") : null;
}

function promotionScopeTelemetryRef(scope: SourceObservationFilterScope): string | null {
  const segments = [
    scope.provider,
    scope.language,
    scope.productLineId,
    scope.seriesId,
    scope.expansionId ?? scope.setId,
    scope.status,
  ].filter((segment): segment is string => Boolean(segment));

  return segments.length > 0 ? segments.join(":") : null;
}

function integrationProfileTelemetryRef(profile: SourceObservationIntegrationProfileSnapshot | null): string | null {
  return profile ? `${profile.profileKey}:${profile.profileVersion}` : null;
}

async function listProviderIntegrationOptions(
  input: {
    providerKey: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
  },
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient,
  profileVersions: CatalogProviderIntegrationProfileVersionReader = staticCatalogProviderIntegrationProfileVersions,
  providerAdapterRegistry: ProviderAdapterRegistry = new ProviderAdapterRegistry([
    createReferenceCardsProviderAdapter(),
    createTcgdexProviderAdapter({
      loadActiveProfileVersion: () => requireCatalogImportProfileVersion(profileVersions, "tcgdex"),
    }),
    createTcgplayerProviderAdapter({
      loadProfileVersions: () => profileVersions.listProfileVersions("tcgplayer"),
      client: tcgplayerAutomationCatalogClient,
    }),
    createMtgjsonProviderAdapter(),
    createLorcanajsonProviderAdapter(),
    createLorcastProviderAdapter(),
    createScryfallProviderAdapter(),
    createYgoprodeckProviderAdapter(),
    createYgojsonProviderAdapter(),
    createScrydexOnePieceProviderAdapter({ credentials: scrydexOnePieceCredentialsFromEnv() }),
  ]),
): Promise<readonly SourceObservationIntegrationOption[]> {
  const versions = await profileVersions.listProfileVersions();
  const activeOptionQueryVersions = versions.filter(isActiveProviderOptionQueryProfileVersion);
  const selectedVersion = profileVersionForProviderOptionQuery(activeOptionQueryVersions, {
    providerKey: input.providerKey,
    queryKind: input.queryKind,
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
  });
  const selectedOptionUnitKey = selectedVersion ? catalogProviderProfileVersionIngestionUnitKey(selectedVersion) : null;
  return listCatalogProviderIntegrationOptionsFromProfiles({
    profiles: (selectedVersion ? [selectedVersion] : activeOptionQueryVersions).map((version) => version.profile),
    providerKey: input.providerKey,
    queryKind: input.queryKind,
    languageCode: input.languageCode,
    parentValue: input.parentValue,
    defaultProviderKey: await defaultSourceObservationImportProviderKey(profileVersions),
    transports: {
      listTcgdexLanguages: () => listTcgdexLanguageOptionRecordsThroughAdapter(providerAdapterRegistry),
      listTcgdexSeries: ({ languageCode }) =>
        listTcgdexSeriesOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode }),
      listTcgdexExpansions: ({ languageCode, seriesId }) =>
        listTcgdexExpansionOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode, seriesId }),
      listTcgplayerProductLines: () =>
        listTcgplayerProductLineOptionRecordsThroughAdapter(providerAdapterRegistry, {
          unitKey: selectedOptionUnitKey,
        }),
      listTcgplayerSetNames: ({ productLineId }) =>
        listTcgplayerSetNameOptionRecordsThroughAdapter(providerAdapterRegistry, {
          productLineId,
          unitKey: selectedOptionUnitKey,
        }),
      listTcgplayerProducts: ({ setName }) =>
        listTcgplayerProductOptionRecordsThroughAdapter(providerAdapterRegistry, {
          setName,
          unitKey: selectedOptionUnitKey,
        }),
      listTcgplayerSkus: ({ productId }) =>
        listTcgplayerSkuOptionRecordsThroughAdapter(providerAdapterRegistry, {
          productId,
          unitKey: selectedOptionUnitKey,
        }),
      listMtgjsonSets: () => listMtgjsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listMtgjsonCards: ({ setCode }) =>
        listMtgjsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listLorcanajsonSets: () => listLorcanajsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listLorcanajsonCards: ({ setCode }) =>
        listLorcanajsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listLorcastSets: () => listLorcastSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listLorcastCards: ({ setCode }) =>
        listLorcastCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listScryfallSets: () => listScryfallSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listScryfallCards: ({ setCode }) =>
        listScryfallCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listScrydexOnePieceSets: () => listScrydexOnePieceSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listScrydexOnePieceCards: ({ setId }) =>
        listScrydexOnePieceCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listScrydexOnePieceSealedProducts: ({ setId }) =>
        listScrydexOnePieceSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listScrydexLorcanaSets: () => listScrydexLorcanaSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listScrydexLorcanaCards: ({ setId }) =>
        listScrydexLorcanaCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listScrydexLorcanaSealedProducts: ({ setId }) =>
        listScrydexLorcanaSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listYgoprodeckSets: () => listYgoprodeckSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listYgoprodeckCards: ({ setCode }) =>
        listYgoprodeckCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listYgojsonSets: () => listYgojsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listYgojsonSealedProducts: () => listYgojsonSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry),
    },
  });
}

async function queryProviderIntegrationOptions(
  input: {
    providerKey: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
    cursor?: string | null;
    limit?: number | null;
    forceRefresh?: boolean | null;
    cacheOnly?: boolean | null;
  },
  db: PgQueryable | null,
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy | null,
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient,
  profileVersions: CatalogProviderIntegrationProfileVersionReader = staticCatalogProviderIntegrationProfileVersions,
  providerAdapterRegistry: ProviderAdapterRegistry = new ProviderAdapterRegistry([
    createReferenceCardsProviderAdapter(),
    createTcgdexProviderAdapter({
      loadActiveProfileVersion: () => requireCatalogImportProfileVersion(profileVersions, "tcgdex"),
    }),
    createTcgplayerProviderAdapter({
      loadProfileVersions: () => profileVersions.listProfileVersions("tcgplayer"),
      client: tcgplayerAutomationCatalogClient,
    }),
    createMtgjsonProviderAdapter(),
    createLorcanajsonProviderAdapter(),
    createLorcastProviderAdapter(),
    createScryfallProviderAdapter(),
    createYgoprodeckProviderAdapter(),
    createYgojsonProviderAdapter(),
    createScrydexOnePieceProviderAdapter({ credentials: scrydexOnePieceCredentialsFromEnv() }),
  ]),
  telemetry?: SourceObservationTelemetry,
): Promise<CatalogProviderOptionQueryPage> {
  const decision = rolloutControlPolicy?.decide({
    capability: "provider-option-query",
    providerKey: input.providerKey,
  });
  const blockingControls = decision?.controls ?? [];
  const rolloutCacheOnly =
    blockingControls.length > 0 &&
    blockingControls.every((control) => control.controlId === "provider-option-queries-cache-only");
  if (decision && !decision.allowed && !rolloutCacheOnly) {
    throw new CatalogIntegrationRolloutControlError(decision);
  }
  const cacheOnly = input.cacheOnly === true || rolloutCacheOnly;

  const versions = await profileVersions.listProfileVersions();
  const activeOptionQueryVersions = versions.filter(isActiveProviderOptionQueryProfileVersion);
  const providerKey = input.providerKey.trim().toLowerCase();
  const queryKind = input.queryKind.trim().toLowerCase();
  const profileVersion = profileVersionForProviderOptionQuery(activeOptionQueryVersions, {
    providerKey,
    queryKind,
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
  });
  const selectedOptionUnitKey = profileVersion ? catalogProviderProfileVersionIngestionUnitKey(profileVersion) : null;
  const liveVersions = profileVersion
    ? activeOptionQueryVersions.filter(
        (version) =>
          version.providerKey === profileVersion.providerKey &&
          version.profileKey === profileVersion.profileKey &&
          version.profileVersion === profileVersion.profileVersion,
      )
    : activeOptionQueryVersions;

  try {
    const page = await queryCatalogProviderIntegrationOptionsWithCache({
      request: {
        providerKey,
        profileKey: profileVersion?.profileKey ?? "catalog-providers",
        profileVersion:
          profileVersion?.profileVersion ??
          `catalog-providers:${activeOptionQueryVersions
            .map(
              (version) =>
                `${version.providerKey}/${version.profileKey}@${version.profileVersion}:${catalogProviderProfileVersionIngestionUnitKey(
                  version,
                )}`,
            )
            .join("|")}`,
        ingestionUnitKey: profileVersion ? catalogProviderProfileVersionIngestionUnitKey(profileVersion) : "catalog",
        queryKind,
        languageCode: input.languageCode,
        parentValue: input.parentValue,
        cursor: input.cursor,
        limit: input.limit,
        forceRefresh: input.forceRefresh,
        cacheOnly,
      },
      cacheStore: createPgCatalogProviderOptionQueryCacheStore(db),
      loadLive: () =>
        listCatalogProviderIntegrationOptionsFromProfiles({
          profiles: liveVersions.map((version) => version.profile),
          providerKey: input.providerKey,
          queryKind: input.queryKind,
          languageCode: input.languageCode,
          parentValue: input.parentValue,
          defaultProviderKey: defaultSourceObservationImportProviderKeyFromVersions(activeOptionQueryVersions),
          transports: {
            listTcgdexLanguages: () => listTcgdexLanguageOptionRecordsThroughAdapter(providerAdapterRegistry),
            listTcgdexSeries: ({ languageCode }) =>
              listTcgdexSeriesOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode }),
            listTcgdexExpansions: ({ languageCode, seriesId }) =>
              listTcgdexExpansionOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode, seriesId }),
            listTcgplayerProductLines: () =>
              listTcgplayerProductLineOptionRecordsThroughAdapter(providerAdapterRegistry, {
                unitKey: selectedOptionUnitKey,
              }),
            listTcgplayerSetNames: ({ productLineId }) =>
              listTcgplayerSetNameOptionRecordsThroughAdapter(providerAdapterRegistry, {
                productLineId,
                unitKey: selectedOptionUnitKey,
              }),
            listTcgplayerProducts: ({ setName }) =>
              listTcgplayerProductOptionRecordsThroughAdapter(providerAdapterRegistry, {
                setName,
                unitKey: selectedOptionUnitKey,
              }),
            listTcgplayerSkus: ({ productId }) =>
              listTcgplayerSkuOptionRecordsThroughAdapter(providerAdapterRegistry, {
                productId,
                unitKey: selectedOptionUnitKey,
              }),
            listMtgjsonSets: () => listMtgjsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listMtgjsonCards: ({ setCode }) =>
              listMtgjsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listLorcanajsonSets: () => listLorcanajsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listLorcanajsonCards: ({ setCode }) =>
              listLorcanajsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listLorcastSets: () => listLorcastSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listLorcastCards: ({ setCode }) =>
              listLorcastCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listScryfallSets: () => listScryfallSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listScryfallCards: ({ setCode }) =>
              listScryfallCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listScrydexOnePieceSets: () => listScrydexOnePieceSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listScrydexOnePieceCards: ({ setId }) =>
              listScrydexOnePieceCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listScrydexOnePieceSealedProducts: ({ setId }) =>
              listScrydexOnePieceSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listScrydexLorcanaSets: () => listScrydexLorcanaSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listScrydexLorcanaCards: ({ setId }) =>
              listScrydexLorcanaCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listScrydexLorcanaSealedProducts: ({ setId }) =>
              listScrydexLorcanaSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listYgoprodeckSets: () => listYgoprodeckSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listYgoprodeckCards: ({ setCode }) =>
              listYgoprodeckCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listYgojsonSets: () => listYgojsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listYgojsonSealedProducts: () =>
              listYgojsonSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry),
          },
        }),
    });
    telemetry?.recordProviderOptionQuery?.({
      providerKey,
      queryKind,
      cacheStatus: page.cache.status,
      cacheSource: page.cache.source,
      result: "success",
      degraded: page.cache.degraded,
      cacheOnly: page.cache.cacheOnly,
      forceRefresh: page.cache.forceRefresh,
    });
    return page;
  } catch (error) {
    telemetry?.recordProviderOptionQuery?.({
      providerKey,
      queryKind,
      cacheStatus: "error",
      cacheSource: "none",
      result: "failure",
      degraded: true,
      cacheOnly,
      forceRefresh: input.forceRefresh === true,
    });
    throw error;
  }
}

function profileVersionForProviderOptionQuery(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  input: Readonly<{
    providerKey: string;
    queryKind: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
  }>,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const providerKey = input.providerKey.trim().toLowerCase();
  const queryKind = input.queryKind.trim().toLowerCase();
  if (queryKind === "providers" || queryKind === "provider") {
    return null;
  }
  const selector = {
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
  };
  const matchingVersions = versions.filter(
    (version) =>
      version.providerKey.trim().toLowerCase() === providerKey &&
      (!selector.profileKey || version.profileKey.trim().toLowerCase() === selector.profileKey.trim().toLowerCase()) &&
      (!selector.ingestionUnitKey ||
        catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() ===
          selector.ingestionUnitKey.trim().toLowerCase()) &&
      version.profile.optionQueries.some(
        (query) => query.queryKind === queryKind || (query.queryKeySynonyms ?? []).includes(queryKind),
      ),
  );
  if (matchingVersions.length === 0) {
    return null;
  }
  if (matchingVersions.length === 1) {
    return matchingVersions[0] ?? null;
  }

  throw new Error(
    `Catalog provider '${providerKey}' has multiple active profile units for option query '${queryKind}'. Select a profileKey or ingestionUnitKey.`,
  );
}

function defaultSourceObservationImportProviderKeyFromVersions(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): string {
  return versions[0]?.providerKey ?? "catalog";
}

async function listTcgdexLanguagesThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly TcgdexLanguageOption[]> {
  const records = await listTcgdexLanguageOptionRecordsThroughAdapter(providerAdapterRegistry);
  return records.map((record) => ({ languageCode: stringRecordValue(record, "languageCode") || "en" }));
}

async function listTcgdexSeriesThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string },
): Promise<readonly TcgdexSeriesOption[]> {
  const records = await listTcgdexSeriesOptionRecordsThroughAdapter(providerAdapterRegistry, input);
  return records.map((record) => ({
    seriesId: stringRecordValue(record, "seriesId") || "",
    name: stringRecordValue(record, "name") || "",
    logoUrl: stringRecordValue(record, "logoUrl"),
  }));
}

async function listTcgdexExpansionsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string; seriesId?: string | null },
): Promise<readonly TcgdexExpansionOption[]> {
  const records = await listTcgdexExpansionOptionRecordsThroughAdapter(providerAdapterRegistry, input);
  return records.map((record) => ({
    expansionId: stringRecordValue(record, "expansionId") || "",
    name: stringRecordValue(record, "name") || "",
    seriesId: stringRecordValue(record, "seriesId"),
    seriesName: stringRecordValue(record, "seriesName"),
    logoUrl: stringRecordValue(record, "logoUrl"),
    symbolUrl: stringRecordValue(record, "symbolUrl"),
    cardCount: numberRecordValue(record, "cardCount"),
    officialCardCount: numberRecordValue(record, "officialCardCount"),
  }));
}

async function listTcgdexLanguageOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireTcgdexAdapter(providerAdapterRegistry).listOptions({
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "languages",
  });
  return result.items.map((item) => ({ languageCode: item.value }));
}

async function listTcgdexSeriesOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgdexAdapter(providerAdapterRegistry).listOptions({
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "series",
    parentValues: { languageCode: input.languageCode },
  });
  return result.items.map((item) => ({
    seriesId: item.value,
    name: item.label,
    aliases: providerOptionAliasesToJson(item.aliases),
    logoUrl: item.metadata?.logoUrl ?? null,
  }));
}

async function listTcgdexExpansionOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string; seriesId?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgdexAdapter(providerAdapterRegistry).listOptions({
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "expansions",
    parentValues: { languageCode: input.languageCode, seriesId: input.seriesId ?? "" },
  });
  return result.items.map((item) => ({
    expansionId: item.value,
    name: item.label,
    seriesId: item.parentValue ?? null,
    seriesName: item.metadata?.seriesName ?? null,
    aliases: providerOptionAliasesToJson(item.aliases),
    logoUrl: item.metadata?.logoUrl ?? null,
    symbolUrl: item.metadata?.symbolUrl ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
    officialCardCount: numberFromString(item.metadata?.officialCardCount),
  }));
}

function requireTcgdexAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<TcgdexObservationPayload> {
  return providerAdapterRegistry.require("tcgdex") as ProviderAdapter<TcgdexObservationPayload>;
}

async function listMtgjsonSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireMtgjsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setCode: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    totalSetSize: numberFromString(item.metadata?.totalSetSize),
    type: item.metadata?.type ?? null,
    mtgjsonVersion: item.metadata?.mtgjsonVersion ?? null,
  }));
}

async function listMtgjsonCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("MTGJSON card option queries require a set code parent value.");
  }

  const result = await requireMtgjsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setCode: item.metadata?.setCode ?? input.setCode,
    setName: item.metadata?.setName ?? null,
    collectorNumber: item.metadata?.collectorNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    layout: item.metadata?.layout ?? null,
    scryfallId: item.metadata?.scryfallId ?? null,
  }));
}

function requireMtgjsonAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<MtgjsonProviderPayload> {
  return providerAdapterRegistry.require("mtgjson") as ProviderAdapter<MtgjsonProviderPayload>;
}

async function listLorcanajsonSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireLorcanajsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setId: item.metadata?.setId ?? item.value,
    setCode: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    prereleaseDate: item.metadata?.prereleaseDate ?? null,
    type: item.metadata?.type ?? null,
    setNumber: item.metadata?.setNumber ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
    formatVersion: item.metadata?.formatVersion ?? null,
    generatedOn: item.metadata?.generatedOn ?? null,
  }));
}

async function listLorcanajsonCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("LorcanaJSON card option queries require a set code parent value.");
  }

  const result = await requireLorcanajsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setCode: item.metadata?.setCode ?? input.setCode,
    setName: item.metadata?.setName ?? null,
    cardNumber: item.metadata?.cardNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    cardType: item.metadata?.cardType ?? null,
    inkColor: item.metadata?.inkColor ?? null,
    tcgplayerProductId: item.metadata?.tcgplayerProductId ?? null,
    imageUrl: item.metadata?.imageUrl ?? null,
  }));
}

function requireLorcanajsonAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<LorcanajsonProviderPayload> {
  return providerAdapterRegistry.require("lorcanajson") as ProviderAdapter<LorcanajsonProviderPayload>;
}

async function listLorcastSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireLorcastAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setId: item.metadata?.setId ?? item.value,
    setCode: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    prereleaseDate: item.metadata?.prereleaseDate ?? null,
    cacheGuidance: item.metadata?.cacheGuidance ?? null,
  }));
}

async function listLorcastCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("Lorcast card option queries require a set code parent value.");
  }

  const result = await requireLorcastAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setId: item.metadata?.setId ?? null,
    setCode: item.metadata?.setCode ?? input.setCode,
    setName: item.metadata?.setName ?? null,
    cardNumber: item.metadata?.cardNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    cardType: item.metadata?.cardType ?? null,
    inkColor: item.metadata?.inkColor ?? null,
    tcgplayerProductId: item.metadata?.tcgplayerProductId ?? null,
    imageUrl: item.metadata?.imageUrl ?? null,
    releaseDate: item.metadata?.releaseDate ?? null,
  }));
}

function requireLorcastAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<LorcastProviderPayload> {
  return providerAdapterRegistry.require("lorcast") as ProviderAdapter<LorcastProviderPayload>;
}

async function listScryfallSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireScryfallAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setCode: item.value,
    name: item.label,
    setId: item.metadata?.setId ?? null,
    setType: item.metadata?.setType ?? null,
    releasedAt: item.metadata?.releasedAt ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
    digital: booleanFromString(item.metadata?.digital),
  }));
}

async function listScryfallCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("Scryfall card option queries require a set code parent value.");
  }

  const result = await requireScryfallAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setCode: item.metadata?.setCode ?? input.setCode,
    oracleId: item.metadata?.oracleId ?? null,
    setName: item.metadata?.setName ?? null,
    collectorNumber: item.metadata?.collectorNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    imageStatus: item.metadata?.imageStatus ?? null,
    imageUrl: null,
  }));
}

function requireScryfallAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<ScryfallProviderPayload> {
  return providerAdapterRegistry.require("scryfall") as ProviderAdapter<ScryfallProviderPayload>;
}

async function listScrydexOnePieceSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    expansionId: item.value,
    name: item.label,
    code: item.metadata?.code ?? null,
    total: numberFromString(item.metadata?.total),
    releaseDate: item.metadata?.releaseDate ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

async function listScrydexOnePieceCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex One Piece card option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "cards",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    number: item.metadata?.number ?? null,
    printedNumber: item.metadata?.printedNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    rarityCode: item.metadata?.rarityCode ?? null,
    type: item.metadata?.type ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

async function listScrydexOnePieceSealedProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex One Piece sealed-product option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "sealed-products",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    sealedProductId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    type: item.metadata?.type ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

async function listScrydexLorcanaSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    expansionId: item.value,
    name: item.label,
    code: item.metadata?.code ?? null,
    total: numberFromString(item.metadata?.total),
    releaseDate: item.metadata?.releaseDate ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

async function listScrydexLorcanaCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex Lorcana card option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "cards",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    number: item.metadata?.number ?? null,
    printedNumber: item.metadata?.printedNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    rarityCode: item.metadata?.rarityCode ?? null,
    type: item.metadata?.type ?? null,
    inkColor: item.metadata?.inkColor ?? null,
    tcgplayerProductId: item.metadata?.tcgplayerProductId ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

async function listScrydexLorcanaSealedProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex Lorcana sealed-product option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "sealed-products",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    sealedProductId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    type: item.metadata?.type ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

function requireScrydexOnePieceAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<ScrydexOnePieceProviderPayload> {
  return providerAdapterRegistry.require("scrydex") as ProviderAdapter<ScrydexOnePieceProviderPayload>;
}

async function listYgoprodeckSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireYgoprodeckAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setName: item.value,
    setCode: item.metadata?.setCode ?? null,
    releaseDate: item.metadata?.releaseDate ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
  }));
}

async function listYgoprodeckCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("YGOPRODeck card option queries require a selected set name or set code.");
  }

  const result = await requireYgoprodeckAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setName: input.setCode, setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardPrintId: item.value,
    name: item.label,
    setName: item.metadata?.setName ?? input.setCode,
    setCode: item.metadata?.setCode ?? null,
    cardId: item.metadata?.cardId ?? null,
    rarity: item.metadata?.rarity ?? null,
    cardType: item.metadata?.cardType ?? null,
    frameType: item.metadata?.frameType ?? null,
    race: item.metadata?.race ?? null,
    attribute: item.metadata?.attribute ?? null,
    archetype: item.metadata?.archetype ?? null,
    imageEvidenceAvailable: booleanFromString(item.metadata?.imageEvidenceAvailable),
  }));
}

function requireYgoprodeckAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<YgoprodeckProviderPayload> {
  return providerAdapterRegistry.require("ygoprodeck") as ProviderAdapter<YgoprodeckProviderPayload>;
}

async function listYgojsonSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireYgojsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setId: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    localeCount: numberFromString(item.metadata?.localeCount),
    printCount: numberFromString(item.metadata?.printCount),
    packContentEvidenceCount: numberFromString(item.metadata?.packContentEvidenceCount),
    yugipediaId: item.metadata?.yugipediaId ?? null,
  }));
}

async function listYgojsonSealedProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireYgojsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sealed-products",
  });
  return result.items.map((item) => ({
    sealedProductId: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    localeCount: numberFromString(item.metadata?.localeCount),
    boxOfSetCount: numberFromString(item.metadata?.boxOfSetCount),
    packContentEvidenceCount: numberFromString(item.metadata?.packContentEvidenceCount),
    yugipediaId: item.metadata?.yugipediaId ?? null,
  }));
}

function requireYgojsonAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<YgojsonProviderPayload> {
  return providerAdapterRegistry.require("ygojson") as ProviderAdapter<YgojsonProviderPayload>;
}

async function listTcgplayerProductLineOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { unitKey?: string | null } = {},
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "product-lines",
  });
  return result.items.map((item) => ({
    productLineId: numberFromString(item.value),
    productLineName: item.label,
    productLineUrlName: item.metadata?.productLineUrlName ?? null,
    isDirect: booleanFromString(item.metadata?.isDirect),
  }));
}

async function listTcgplayerSetNameOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { productLineId: number; unitKey?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "set-names",
    parentValues: { productLineId: String(input.productLineId) },
  });
  return result.items.map((item) => ({
    setNameId: numberFromString(item.metadata?.setNameId),
    categoryId: numberFromString(item.metadata?.categoryId),
    name: item.label,
    cleanSetName: item.value,
    urlName: item.metadata?.urlName ?? null,
    abbreviation: item.metadata?.abbreviation ?? null,
    releaseDate: item.metadata?.releaseDate ?? null,
    isSupplemental: booleanFromString(item.metadata?.isSupplemental),
    active: booleanFromString(item.metadata?.active),
  }));
}

async function listTcgplayerProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setName: string; unitKey?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "products",
    parentValues: { setName: input.setName },
  });
  return result.items.map((item) => ({
    productId: numberFromString(item.value),
    productName: item.label,
    productLineId: numberFromString(item.metadata?.productLineId),
    productLineName: item.metadata?.productLineName ?? null,
    productTypeName: item.metadata?.productTypeName ?? null,
    setId: numberFromString(item.metadata?.setId),
    setName: item.metadata?.setName ?? input.setName,
    rarityName: item.metadata?.rarityName ?? null,
    sealed: booleanFromString(item.metadata?.sealed),
  }));
}

async function listTcgplayerSkuOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { productId: number; unitKey?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "skus",
    parentValues: { productId: String(input.productId) },
  });
  return result.items.map((item) => ({
    sku: numberFromString(item.value),
    condition: item.metadata?.condition ?? null,
    variant: item.metadata?.variant ?? null,
    language: item.metadata?.language ?? null,
  }));
}

function requireTcgplayerAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<TcgplayerProviderPayload> {
  return providerAdapterRegistry.require("tcgplayer") as ProviderAdapter<TcgplayerProviderPayload>;
}

function stringRecordValue(record: JsonValue, key: string): string | null {
  if (!isJsonRecord(record)) {
    return null;
  }
  const value = record[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }
  return null;
}

// Serialize typed option aliases to JSON records so they survive the adapter ->
// option-query record -> resolver hop without losing their typed shape. The
// resolver maps them back onto the typed `aliases` field on each option DTO.
function providerOptionAliasesToJson(aliases: readonly ProviderOptionAlias[] | undefined): JsonValue {
  return (aliases ?? []).map((alias) => ({
    aliasText: alias.aliasText,
    aliasLanguageCode: alias.aliasLanguageCode,
    aliasType: alias.aliasType,
    confidence: alias.confidence,
    reviewStatus: alias.reviewStatus,
    sourceCategory: alias.sourceCategory,
    ...(alias.evidence ? { evidence: alias.evidence } : {}),
  }));
}

function numberRecordValue(record: JsonValue, key: string): number | null {
  return numberFromString(stringRecordValue(record, key));
}

function numberFromString(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanFromString(value: string | null | undefined): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return null;
}

function scrydexOnePieceCredentialsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ScrydexOnePieceCredentials | undefined {
  const apiKey = env.SCRYDEX_API_KEY?.trim() || "";
  const teamId = env.SCRYDEX_TEAM_ID?.trim() || "";

  return apiKey && teamId ? { apiKey, teamId } : undefined;
}

async function buildCatalogIntegrationControlPlaneReadiness(
  providerAdapterRegistry: ProviderAdapterRegistry,
  dryRunProofRegistry: CatalogIntegrationDryRunProofRegistry = createCatalogIntegrationDryRunProofRegistry(),
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy = createCatalogIntegrationRolloutControlPolicyFromEnv(),
): Promise<CatalogIntegrationControlPlaneReadiness> {
  const units: CatalogIntegrationControlPlaneUnitReadiness[] = [];
  const rolloutControls = rolloutControlPolicy.snapshot();

  for (const providerKey of providerAdapterRegistry.listProviderKeys()) {
    const adapter = providerAdapterRegistry.require(providerKey);
    const [descriptors, transportDiagnostics, credentialReadiness] = await Promise.all([
      adapter.listIntegrationUnits(),
      adapter.getTransportDiagnostics(),
      adapter.getCredentialReadiness(),
    ]);

    for (const descriptor of descriptors) {
      const dryRun = (await dryRunProofRegistry.get(descriptor.unitKey)?.()) ?? null;
      const dryRunDiagnostics =
        dryRun?.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.diagnosticText,
          unitKey: diagnostic.unitKey,
          retryAfterSeconds: undefined,
        })) ?? [];
      const unitCredentialReadiness = selectUnitCredentialReadiness(credentialReadiness, descriptor.unitKey);
      const credentialDiagnostics = unitCredentialReadiness
        .map(catalogProviderCredentialReadinessToTransportDiagnostic)
        .filter((diagnostic): diagnostic is ProviderTransportDiagnostic => diagnostic !== null);
      const providerDiagnostics = [
        ...transportDiagnostics.filter(
          (diagnostic) => !diagnostic.unitKey || diagnostic.unitKey === descriptor.unitKey,
        ),
        ...credentialDiagnostics,
      ].map((diagnostic) => toControlPlaneDiagnostic(diagnostic, "provider-adapter"));
      const rolloutDiagnostics = rolloutControlDiagnosticsForUnit(rolloutControlPolicy, {
        providerKey: descriptor.providerKey,
        unitKey: descriptor.unitKey,
      });
      const catalogDiagnostics = dryRunDiagnostics.map((diagnostic) => toControlPlaneDiagnostic(diagnostic, "catalog"));
      const unitDiagnostics = [...providerDiagnostics, ...catalogDiagnostics, ...rolloutDiagnostics];
      const errorCount = countDiagnostics(unitDiagnostics, "error");
      const dryRunErrorCount = countDiagnostics(catalogDiagnostics, "error");
      const credentialStatus = summarizeUnitCredentialReadiness(unitCredentialReadiness);
      const transportRolloutBlocked = rolloutControlPolicy.decide({
        capability: "provider-transport",
        providerKey: descriptor.providerKey,
        unitKey: descriptor.unitKey,
      }).allowed
        ? false
        : true;

      units.push({
        unitKey: descriptor.unitKey,
        providerKey: descriptor.providerKey,
        displayName: descriptor.displayName,
        productDomain: descriptor.productDomain,
        productForm: descriptor.productForm,
        ingestionPurpose: descriptor.ingestionPurpose ?? null,
        profileVersion: descriptor.profileVersion ?? "",
        semanticReadiness: dryRun && dryRunErrorCount === 0 && dryRun.observations.length > 0 ? "ready" : "blocked",
        credentialReadiness: credentialStatus.readiness,
        credentialReadinessState: credentialStatus.state,
        credentialRequirement: credentialStatus.requirement,
        credentialDiagnosticCode: credentialStatus.diagnosticCode,
        transportReadiness:
          !transportRolloutBlocked && countDiagnostics(providerDiagnostics, "error") === 0 ? "ready" : "blocked",
        fixtureValidationStatus: dryRun && dryRun.observations.length > 0 ? "ready" : "blocked",
        dryRunStatus: dryRun && dryRunErrorCount === 0 ? "completed" : "blocked",
        observationFacts: dryRun?.observations.length ?? 0,
        diagnosticCounts: {
          info: countDiagnostics(unitDiagnostics, "info"),
          warning: countDiagnostics(unitDiagnostics, "warning"),
          error: errorCount,
        },
        diagnostics: unitDiagnostics,
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
    rolloutControls,
    units,
  };
}

function rolloutControlDiagnosticsForUnit(
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy,
  input: Readonly<{ providerKey: string; unitKey: string }>,
): readonly CatalogIntegrationControlPlaneDiagnostic[] {
  const controls = [
    rolloutControlPolicy.decide({
      capability: "provider-transport",
      providerKey: input.providerKey,
      unitKey: input.unitKey,
    }),
    rolloutControlPolicy.decide({
      capability: "provider-option-query",
      providerKey: input.providerKey,
      unitKey: input.unitKey,
    }),
    rolloutControlPolicy.decide({
      capability: "import",
      providerKey: input.providerKey,
      unitKey: input.unitKey,
    }),
  ].flatMap((decision) => decision.controls);
  const uniqueControls = new Map(controls.map((control) => [control.controlId, control]));

  return [...uniqueControls.values()].map((control) => ({
    code: "catalog-integration-rollout-control-denied",
    severity: control.severity === "error" ? "error" : "warning",
    message: control.message,
    unitKey: input.unitKey,
    retryAfterSeconds: null,
    source: "catalog",
  }));
}

function selectUnitCredentialReadiness(
  readiness: readonly CatalogProviderCredentialReadiness[],
  unitKey: string,
): readonly CatalogProviderCredentialReadiness[] {
  const attributed = readiness.filter((item) => item.unitKey === unitKey);
  return attributed.length > 0 ? attributed : readiness.filter((item) => !item.unitKey);
}

function summarizeUnitCredentialReadiness(readiness: readonly CatalogProviderCredentialReadiness[]): Readonly<{
  readiness: "ready" | "blocked" | "not-required";
  state: CatalogProviderCredentialReadinessState;
  requirement: CatalogProviderCredentialRequirement;
  diagnosticCode: string | null;
}> {
  if (readiness.length === 0) {
    return {
      readiness: "blocked",
      state: "unknown",
      requirement: "required",
      diagnosticCode: "adapter-authentication-failed",
    };
  }

  const blocker = readiness.find((item) => item.importBlocking);
  if (blocker) {
    return {
      readiness: "blocked",
      state: blocker.state,
      requirement: blocker.requirement,
      diagnosticCode: blocker.diagnosticCode,
    };
  }

  const required = readiness.find((item) => item.requirement === "required");
  if (required) {
    return {
      readiness: "ready",
      state: required.state,
      requirement: required.requirement,
      diagnosticCode: required.diagnosticCode,
    };
  }

  const notRequired = readiness.find((item) => item.state === "not-required");
  return {
    readiness: "not-required",
    state: notRequired?.state ?? "unknown",
    requirement: notRequired?.requirement ?? "not-required",
    diagnosticCode: notRequired?.diagnosticCode ?? null,
  };
}

function countDiagnostics(
  diagnostics: readonly Pick<CatalogIntegrationControlPlaneDiagnostic, "severity">[],
  severity: CatalogIntegrationControlPlaneDiagnostic["severity"],
): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
}

function toControlPlaneDiagnostic(
  diagnostic: Pick<ProviderTransportDiagnostic, "code" | "severity" | "message" | "unitKey" | "retryAfterSeconds">,
  source: CatalogIntegrationControlPlaneDiagnostic["source"],
): CatalogIntegrationControlPlaneDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    unitKey: diagnostic.unitKey ?? null,
    retryAfterSeconds: diagnostic.retryAfterSeconds ?? null,
    source,
  };
}

function normalizeIntegrationKey(value: string): string {
  return value.trim().toLowerCase();
}

async function requireCatalogImportProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string | null | undefined,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const normalizedProvider = normalizeIntegrationKey(
    providerKey || (await defaultSourceObservationImportProviderKey(profileVersions)),
  );
  const version = await profileVersions.getActiveProfileVersion(normalizedProvider, selector);
  if (!version || !isActiveSourceObservationImportProfileVersion(version)) {
    throw new Error(`Provider '${normalizedProvider}' does not support background import.`);
  }

  return version;
}

async function requireCatalogImportProfileVersionForJob(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string | null | undefined,
  snapshot: SourceObservationIntegrationProfileSnapshot | null,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  if (!snapshot) {
    return requireCatalogImportProfileVersion(profileVersions, providerKey, selector);
  }

  const versions = await profileVersions.listProfileVersions(snapshot.providerKey);
  const version = versions.find(
    (candidate) =>
      candidate.providerKey === snapshot.providerKey &&
      candidate.profileKey === snapshot.profileKey &&
      candidate.profileVersion === snapshot.profileVersion &&
      (!snapshot.ingestionUnitKey ||
        catalogProviderProfileVersionIngestionUnitKey(candidate) === snapshot.ingestionUnitKey),
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
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const normalizedProvider = normalizeIntegrationKey(
    providerKey || (await defaultSourceObservationImportProviderKey(profileVersions)),
  );
  const providerProfile = await profileVersions.getActiveProfileVersion(normalizedProvider, selector);
  if (providerProfile && isActivePromotionProfileVersion(providerProfile)) {
    return providerProfile;
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

  const sourceProfileKey = requireOriginalSourceProfileMarker(
    observation.source_profile_key,
    "source profile key",
    observation.observation_id,
  ).toLowerCase();
  const sourceProfileVersion = requireOriginalSourceProfileMarker(
    observation.source_profile_version,
    "source profile version",
    observation.observation_id,
  );
  requireOriginalSourceProfileMarker(
    observation.source_mapping_fingerprint,
    "source mapping fingerprint",
    observation.observation_id,
  );

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

async function requireReferenceDataPromotionProfileVersionForReapply(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  observation: SourceObservationDetailRow,
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized,
  mode: SourceObservationReapplyProfileMode,
  snapshot: SourceObservationIntegrationProfileSnapshot | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  if (mode === "current-active-profile") {
    if (snapshot) {
      return requireReferenceDataPromotionProfileVersionFromSnapshot(profileVersions, snapshot, normalized);
    }
    return requireReferenceDataPromotionProfileVersion(profileVersions, observation.provider_key, normalized);
  }

  const sourceProfileKey = requireOriginalSourceProfileMarker(
    observation.source_profile_key,
    "source profile key",
    observation.observation_id,
  ).toLowerCase();
  const sourceProfileVersion = requireOriginalSourceProfileMarker(
    observation.source_profile_version,
    "source profile version",
    observation.observation_id,
  );
  requireOriginalSourceProfileMarker(
    observation.source_mapping_fingerprint,
    "source mapping fingerprint",
    observation.observation_id,
  );

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

  assertReferenceDataPromotionProfileCompatible(version, normalized);
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

async function requireReferenceDataPromotionProfileVersionFromSnapshot(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  snapshot: SourceObservationIntegrationProfileSnapshot,
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const version = await findCatalogProfileVersionFromSnapshot(profileVersions, snapshot);
  if (!version) {
    throw new Error(
      `Catalog provider profile version ${snapshot.providerKey}@${snapshot.profileVersion} from the integration job snapshot was not found.`,
    );
  }

  assertReferenceDataPromotionProfileCompatible(version, normalized);
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
        candidate.profileVersion === snapshot.profileVersion &&
        (!snapshot.ingestionUnitKey ||
          catalogProviderProfileVersionIngestionUnitKey(candidate) === snapshot.ingestionUnitKey),
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

function assertReferenceDataPromotionProfileCompatible(
  version: CatalogProviderIntegrationProfileVersionRecord,
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized,
): void {
  if (!version.profile.capabilities.includes("reference-data-promotion")) {
    throw new Error(`Provider '${version.providerKey}' does not support Reference Data promotion.`);
  }
  if (version.profile.normalizedObservationMapping.kind !== normalized.kind) {
    throw new Error(
      `Provider '${version.providerKey}' reference promotion mapping '${version.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
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
    ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    lifecycle: version.lifecycle,
    connectorKind: version.profile.connector.kind,
    connectorSourceVersion: profileConnectorSourceVersion(version.profile.connector),
    sourceMappingFingerprint: catalogProviderSourceMappingFingerprint(requireSourceObservationMappingContract(version)),
  };
}

function snapshotCatalogReapplyProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): SourceObservationIntegrationProfileSnapshot {
  return snapshotCatalogProfileVersion(version);
}

function integrationProfileSnapshotKey(
  snapshot: SourceObservationIntegrationProfileSnapshot | null,
  owner: string,
): string {
  if (!snapshot) {
    throw new Error(`Source Observation integration job ${owner} is missing profile snapshot.`);
  }
  return `${snapshot.providerKey}:${snapshot.profileKey}:${snapshot.profileVersion}:${snapshot.ingestionUnitKey ?? "legacy-unit"}`;
}

function commonProfileSnapshot(
  snapshots: readonly (SourceObservationIntegrationProfileSnapshot | null)[],
): SourceObservationIntegrationProfileSnapshot | null {
  let common: SourceObservationIntegrationProfileSnapshot | null = null;

  for (const snapshot of snapshots) {
    if (!snapshot) {
      continue;
    }
    if (!common) {
      common = snapshot;
      continue;
    }
    if (
      snapshot.providerKey !== common.providerKey ||
      snapshot.profileKey !== common.profileKey ||
      snapshot.profileVersion !== common.profileVersion ||
      (snapshot.ingestionUnitKey ?? null) !== (common.ingestionUnitKey ?? null)
    ) {
      return null;
    }
  }

  return common;
}

function profileConnectorSourceVersion(
  connector: CatalogProviderIntegrationProfileVersionRecord["profile"]["connector"],
): string | null {
  if ("sourceRepository" in connector) {
    return connector.sourceRepository.commit;
  }
  if ("sourceContractDocument" in connector) {
    return connector.sourceContractDocument;
  }

  return null;
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
  const action = job.payload.action;
  const result = job.result;
  return {
    jobId: job.jobId,
    syncRunId: job.payload.syncRunId ?? null,
    action,
    scope: normalizeIntegrationJobScope(job.payload.scope),
    profileSnapshot: job.payload.profileSnapshot ?? null,
    reapplyProfileMode: normalizeReapplyProfileMode(job.payload.reapplyProfileMode),
    status: job.status,
    operatorStatus: integrationJobOperatorStatus(job),
    consistency: {
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: action === "reapply" ? "leased-work-units" : "leased-job-turns",
    },
    progress: job.progress,
    result,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function integrationJobOperatorStatus(
  job: SourceObservationIntegrationDurableJobRecord,
): SourceObservationIntegrationJobOperatorStatus {
  if (isOperatorCancelledIntegrationJob(job)) {
    return "cancelled";
  }
  if (job.status === "completed") {
    return integrationJobCompletedOperatorStatus(job);
  }
  if (job.status === "failed") {
    return "failed";
  }
  if (job.progress.phase === "completed") {
    return integrationJobCompletedOperatorStatus(job);
  }
  if (job.progress.phase === "failed") {
    return "failed";
  }
  if (integrationJobHasActiveProgress(job)) {
    if (isDurableJobClaimExpired(job)) {
      return "stale";
    }
    return "running";
  }
  if (job.status === "running" && isDurableJobClaimExpired(job)) {
    return "stale";
  }

  return job.status;
}

const reusableActiveIntegrationJobOperatorStatuses = new Set<SourceObservationIntegrationJobOperatorStatus>([
  "queued",
  "running",
]);

function integrationJobCompletedOperatorStatus(
  job: SourceObservationIntegrationDurableJobRecord,
): SourceObservationIntegrationJobOperatorStatus {
  if (job.result && job.result.failed > 0) {
    return "partial";
  }

  return "completed";
}

function integrationJobHasActiveProgress(job: SourceObservationIntegrationDurableJobRecord): boolean {
  return job.status === "running" || (job.status === "queued" && job.progress.phase !== "queued");
}

function isOperatorCancelledIntegrationJob(job: Readonly<{ status: DurableJobStatus; errorMessage: string | null }>) {
  return job.status === "failed" && job.errorMessage === OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE;
}

function isDurableJobClaimExpired(job: Readonly<{ claimedUntil: string | null }>) {
  if (!job.claimedUntil) {
    return true;
  }

  const claimedUntil = Date.parse(job.claimedUntil);
  return !Number.isFinite(claimedUntil) || claimedUntil <= Date.now();
}

function retryableIntegrationJobResult(
  result: SourceObservationIntegrationJobResult | null,
  requestedFallback: number,
): SourceObservationIntegrationJobResult {
  if (!result) {
    return summarizeIntegrationJobOutcomes(Math.max(0, requestedFallback), []);
  }

  return summarizeIntegrationJobOutcomes(
    result.requested,
    result.outcomes.filter((outcome) => outcome.status !== "failed"),
  );
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

function toCatalogSyncRunFanoutEventSnapshot(
  job: CatalogSyncRunDurableJobRecord,
): DurableJobPublicSnapshot<CatalogSyncRunFanoutProgress, CatalogSyncRunFanoutResult> {
  return {
    jobId: job.jobId,
    jobKind: job.jobKind,
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

function selectedCatalogSyncRunUnits(
  preview: CatalogSyncProviderParticipationPreview,
): readonly CatalogSyncRunSelectedUnitSnapshot[] {
  return preview.units
    .filter((unit) => unit.selected && unit.eligibility === "eligible" && unit.childExecutionScope)
    .map((unit) => ({
      providerKey: unit.providerKey,
      unitKey: unit.unitKey,
      profileKey: unit.profileKey,
      profileVersion: unit.profileVersion,
      displayName: unit.displayName,
      role: unit.role,
      requirement: unit.requirement,
      childExecutionScope: normalizeIntegrationJobScope(unit.childExecutionScope ?? {}),
    }))
    .sort((left, right) => left.unitKey.localeCompare(right.unitKey));
}

function catalogSyncRunIdempotencyKey(
  context: EventStoreContext,
  scope: CatalogSyncScope,
  selectedUnits: readonly CatalogSyncRunSelectedUnitSnapshot[],
): string {
  return createHash("sha256")
    .update(
      stableJsonStringify({
        tenantId: context.tenantId,
        forAccountId: context.audit?.forAccountId ?? null,
        performedByUserId: context.audit?.performedByUserId ?? null,
        scope,
        selectedUnits,
      }),
    )
    .digest("hex");
}

function catalogSyncRunFanoutProgress(
  completed: number,
  total: number,
  currentName: string | null,
  status: CatalogSyncRunFanoutProgress["status"],
  phase: CatalogSyncRunFanoutProgress["phase"],
): CatalogSyncRunFanoutProgress {
  return {
    phase,
    completed,
    total,
    currentName,
    status,
  };
}

function catalogSyncRunChildStatus(
  link: CatalogSyncRunChildJobLink,
  job: SourceObservationIntegrationJob | null,
): CatalogSyncRunChildStatus {
  if (link.syncRunLinkState === "reused-settled-child-job") {
    return "completed";
  }
  if (!job) {
    return link.syncRunLinkState === "child-enqueue-failed" ? "failed" : "queued";
  }
  if (link.syncRunLinkState === "reused-active-child-job" && job.status === "queued") {
    return "reused-active-job";
  }
  return job.operatorStatus;
}

// --- Durable per-scope sync state -----------------------------------------
//
// CatalogSyncRun/SourceObservationIntegrationJob are transient per-run durable
// jobs: once a run's rows are pruned by retention, its cross-provider history
// is gone. `catalog_scope_sync_state` is the durable read model that survives
// across runs — one row per (scope, provider unit) — updated at two points:
// right after a run's fan-out (`recordCatalogScopeSyncStateForRun`, covering
// the never-synced -> pending/settled/failed transition for every selected
// unit in one shot) and when an individual child job reaches a terminal
// status or is retried (`recordCatalogScopeSyncStateForChildJob`, covering
// pending/running -> settled/failed and failed -> pending on retry).
// CatalogSyncScope v2 carries the canonical scope record id, so the durable row
// is keyed on a hash of the v2 scope descriptor (productDomain / productForm /
// languageCode / referenceKind / scopeRecordId) via `computeCatalogSyncScopeKey`.

function catalogScopeSyncStateDescriptor(scope: CatalogSyncScope): CatalogScopeSyncScopeDescriptor {
  return {
    productDomain: scope.productDomain,
    productForm: scope.productForm ?? null,
    languageCode: scope.languageCode ?? null,
    referenceKind: scope.reference.kind,
    scopeRecordId: scope.reference.scopeRecordId,
  };
}

function compactStringRecord(
  scope: Readonly<Record<string, string | null | undefined>> | null | undefined,
): Readonly<Record<string, string>> {
  if (!scope) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(scope).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
}

function recordFromUnknownStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function catalogScopeSyncObservedStatusFromChildLink(
  link: CatalogSyncRunChildJobLink,
  job: SourceObservationIntegrationJob | null,
): CatalogScopeSyncUnitObservedStatus {
  if (link.syncRunLinkState === "reused-settled-child-job") {
    return "reused-settled-job";
  }
  if (!job) {
    return link.syncRunLinkState === "child-enqueue-failed" ? "enqueue-failed" : "queued";
  }
  if (link.syncRunLinkState === "reused-active-child-job" && job.status === "queued") {
    return "queued";
  }
  return job.operatorStatus;
}

function childExecutionScopesMatch(
  a: SourceObservationIntegrationJobScope,
  b: SourceObservationIntegrationJobScope,
): boolean {
  return JSON.stringify(normalizeIntegrationJobScope(a)) === JSON.stringify(normalizeIntegrationJobScope(b));
}

function catalogSyncRunProgress(
  childJobs: readonly CatalogSyncRunChildJob[],
  selectedUnitCount: number,
): CatalogSyncRunProgress {
  const providerTargetTotals = childJobs.reduce(
    (totals, childJob) => {
      const progress = childJob.job?.progress;
      return {
        completed: totals.completed + (progress?.completed ?? (isCatalogSyncRunTerminalChild(childJob) ? 1 : 0)),
        total: totals.total + (progress?.total ?? 1),
      };
    },
    { completed: 0, total: 0 },
  );

  return {
    childJobs: {
      total: selectedUnitCount,
      queued: childJobs.filter((childJob) => childJob.status === "queued" || childJob.status === "reused-active-job")
        .length,
      running: childJobs.filter((childJob) => childJob.status === "running").length,
      completed: childJobs.filter((childJob) => childJob.status === "completed").length,
      partial: childJobs.filter((childJob) => childJob.status === "partial").length,
      failed: childJobs.filter((childJob) => childJob.status === "failed").length,
      cancelled: childJobs.filter((childJob) => childJob.status === "cancelled").length,
      stale: childJobs.filter((childJob) => childJob.status === "stale").length,
    },
    providerTargets: {
      completed: providerTargetTotals.completed,
      total: providerTargetTotals.total || selectedUnitCount,
    },
  };
}

function catalogSyncRunOperatorStatus(
  childJobs: readonly CatalogSyncRunChildJob[],
  selectedUnitCount: number,
  fanoutStatus: DurableJobStatus,
): CatalogSyncRunOperatorStatus {
  if (childJobs.length === 0) {
    return fanoutStatus === "failed" ? "failed" : "queued";
  }

  const failed = childJobs.some((childJob) => childJob.status === "failed");
  const cancelled = childJobs.some((childJob) => childJob.status === "cancelled");
  const partial = childJobs.some((childJob) => childJob.status === "partial");
  const active = childJobs.some(
    (childJob) =>
      childJob.status === "queued" ||
      childJob.status === "running" ||
      childJob.status === "stale" ||
      childJob.status === "retried" ||
      childJob.status === "reused-active-job",
  );
  const running = childJobs.some(
    (childJob) =>
      childJob.status === "running" ||
      childJob.status === "stale" ||
      childJob.status === "retried" ||
      childJob.status === "partial",
  );
  const completed = childJobs.filter((childJob) => childJob.status === "completed").length;

  if (active) {
    return completed === 0 && !running ? "queued" : "running";
  }
  if (cancelled && completed === 0 && !partial) {
    return "cancelled";
  }
  if (failed || partial || cancelled || childJobs.length < selectedUnitCount) {
    return completed > 0 || partial ? "partial" : "failed";
  }

  return "completed";
}

function isCatalogSyncRunTerminalChild(childJob: CatalogSyncRunChildJob): boolean {
  return (
    childJob.status === "completed" ||
    childJob.status === "partial" ||
    childJob.status === "failed" ||
    childJob.status === "cancelled"
  );
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

function terminalPromotionOutcomeFromEvents(
  jobId: string,
  events: readonly SourceObservationJobEvent<SourceObservationBulkJob>[],
): SourceObservationPromotionOutcomeRecord | null {
  let terminalEvent: SourceObservationJobEvent<SourceObservationBulkJob> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.job.action === "promote" && (event.job.status === "completed" || event.job.status === "failed")) {
      terminalEvent = event;
      break;
    }
  }
  if (!terminalEvent) {
    return null;
  }

  const result = terminalEvent.job.result;
  const promotionResult = result && "promoted" in result ? result : null;
  const requested = promotionResult?.requested ?? terminalEvent.job.progress.total;
  const promoted = promotionResult?.promoted ?? 0;
  const skipped = promotionResult?.skipped ?? 0;
  const recordedFailed = promotionResult?.failed ?? 0;
  const failed =
    terminalEvent.job.status === "failed" || !promotionResult
      ? Math.max(recordedFailed, requested - promoted - skipped)
      : recordedFailed;
  const terminalState =
    terminalEvent.job.status === "failed" || (failed > 0 && promoted === 0)
      ? "failed"
      : failed > 0
        ? "partial"
        : "completed";

  return {
    outcomeId: `${jobId}:${terminalEvent.sequence}`,
    jobId,
    eventSequence: terminalEvent.sequence,
    terminalState,
    requested,
    promoted,
    skipped,
    failed,
    outcomes: promotionResult?.outcomes ?? [],
    errorMessage: terminalEvent.job.errorMessage,
    recordedAt: terminalEvent.createdAt,
  };
}

async function requireSourceObservationJobClaim(
  succeeded: Promise<boolean | DurableJobWorkUnitTerminalOutcome> | boolean | DurableJobWorkUnitTerminalOutcome,
) {
  const outcome = await succeeded;
  if (!isDurableJobWorkUnitTerminalAccepted(outcome)) {
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

function isImpactBlockingJob(status: string, action: "import" | "reapply" | SourceObservationBulkJobAction): boolean {
  return action !== "reject" && action !== "defer" && (status === "queued" || status === "running");
}

function impactJobProviderKey(job: SourceObservationIntegrationJob): string | null {
  return job.profileSnapshot?.providerKey ?? job.scope.provider ?? null;
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
    profileKey: scope.profileKey?.trim() || undefined,
    ingestionUnitKey: scope.ingestionUnitKey?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    seriesId: scope.seriesId?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
    productLineId: scope.productLineId?.trim() || undefined,
    setName: scope.setName?.trim() || undefined,
    productId: scope.productId?.trim() || undefined,
    planningFingerprint: scope.planningFingerprint?.trim() || undefined,
  };
}

function normalizeOptionalKey(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeCandidateGenerationScope(
  scope: SourceObservationFilterScope,
  syncRunId: string | null,
): SourceObservationFilterScope {
  return {
    ...scope,
    syncRunId: syncRunId ?? scope.syncRunId,
  };
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function profileSelectorFromScope(
  scope: Readonly<{ profileKey?: string | null; ingestionUnitKey?: string | null }>,
): CatalogProviderProfileVersionSelector | null {
  const profileKey = scope.profileKey?.trim();
  const ingestionUnitKey = scope.ingestionUnitKey?.trim();
  return profileKey || ingestionUnitKey
    ? {
        ...(profileKey ? { profileKey } : {}),
        ...(ingestionUnitKey ? { ingestionUnitKey } : {}),
      }
    : null;
}

function integrationScopeToObservationScope(scope: SourceObservationIntegrationJobScope): SourceObservationFilterScope {
  return {
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    productLineId: scope.productLineId?.trim() || undefined,
    seriesId: scope.seriesId?.trim() || undefined,
    expansionId: scope.setId?.trim() || undefined,
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
    deferred: outcomes.filter((outcome) => outcome.status === "deferred").length,
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
    outcome.status === "deferred" ||
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

function integrationImportPreviewTargetFromPlan(input: {
  targetId: string;
  name: string;
  languageCode: string;
  plan: ProviderImportPlan;
}): SourceObservationIntegrationImportPreviewTarget {
  return {
    targetId: input.targetId,
    name: input.name,
    languageCode: input.languageCode,
    scopeKey: input.plan.scope.scopeKey,
    planKey: input.plan.planKey,
    estimatedPayloads: input.plan.estimatedPayloads ?? null,
    transportSteps: input.plan.transportSteps,
    usageEstimate: input.plan.usageEstimate ?? null,
  };
}

function providerUsageEvidenceFromImportPlan(
  plan: ProviderImportPlan,
  requestKeys: ReadonlySet<string>,
): SourceObservationProviderUsageEvidence | null {
  const estimate = plan.usageEstimate;
  if (!estimate) {
    return null;
  }

  const actualRequestCount = requestKeys.size > 0 ? requestKeys.size : null;
  // Bulk-first adapters attach the fetched response page URL to every payload.
  // Distinct provenance URLs therefore measure both requests and fetched pages.
  const pageCount = estimate.requestStrategy === "bulk-first" ? actualRequestCount : null;
  return {
    unitKey: plan.unitKey,
    requestStrategy: estimate.requestStrategy,
    estimateState: estimate.estimateState,
    estimatedRequestCount: estimate.estimatedRequestCount,
    estimateReason: estimate.estimateReason,
    actualRequestCount,
    pageCount,
    cacheHitCount: null,
    cacheMissCount: null,
    usageCheckState: estimate.usageCheckState,
    creditDiagnostic: estimate.creditDiagnostic,
    degradedDiagnostic: estimate.degradedDiagnostic,
    bulkFirstConfirmed:
      actualRequestCount === null
        ? null
        : estimate.requestStrategy === "bulk-first" && !estimate.perRecordFallbackReason,
    perRecordFallbackReason: estimate.perRecordFallbackReason,
    selectedFields: estimate.selectedFields,
    pageSize: estimate.pageSize,
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
