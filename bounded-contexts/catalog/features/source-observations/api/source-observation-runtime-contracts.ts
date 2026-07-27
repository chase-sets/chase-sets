import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { type DurableJobRecord } from "@chase-sets/platform-runtime/durable-job-store";
import { type DurableJobWorkUnitSummary } from "@chase-sets/platform-runtime/durable-job-work-units";
import { type JsonValue } from "@chase-sets/primitives/json";
import type { CatalogItemId, ReferenceRecordId } from "../../../ids";
import { type CatalogScopeSyncUnitState } from "../../scope-sync-state/domain/state";
import {
  type SourceObservationCommand,
  type SourceObservationEvent,
  type SourceObservationState,
} from "../domain/domain";
import {
  type CatalogMergeCandidateConflictResolution,
  type CatalogMergeCandidateReviewSnapshot,
  type CatalogMergeCandidateState,
} from "../domain/catalog-merge-candidate";
import {
  getSourceObservationDetail,
  listCatalogMergeCandidates,
  listSourceObservations,
  type SourceObservationFilterScope,
  type SourceObservationIntegrationScopeRow,
  type SourceObservationPromotionPreview,
  type SourceObservationReapplyPreview,
} from "../read-model/queries";
import {
  type CatalogMergeCandidateMatchExclusion,
  type CatalogMergeCandidateMatchResult,
} from "./catalog-merge-candidate-matcher";
import {
  type CatalogMergeCandidatePromotionCommandPlanResult,
  type CatalogMergeCandidatePromotionCandidate,
  type CatalogMergeCandidatePromotionCatalogMapping,
  type CatalogMergeCandidatePromotionAssetPlan,
} from "./catalog-merge-candidate-promotion-planner";
import { type TcgdexExpansionOption, type TcgdexLanguageOption, type TcgdexSeriesOption } from "./tcgdex-client";
import type { CatalogAliasCandidate } from "../../alias-equivalence/domain/alias";
import { type PromotionAliasServices } from "./provider-promotion-alias-writer";
import {
  getActiveCatalogProviderIntegrationProfileVersion,
  listCatalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  type CatalogProviderCredentialRequirement,
  type CatalogProviderCredentialReadinessState,
} from "./catalog-integration-credential-readiness";
import {
  type CatalogIntegrationRolloutControlPolicy,
  type CatalogIntegrationRolloutControlSnapshot,
} from "./catalog-integration-rollout-controls";
import {
  type CatalogSyncAcceptedScopeMapping,
  type CatalogSyncProviderParticipationPreview,
  type CatalogSyncScope,
} from "./catalog-sync-scope-planner";
import type {
  CatalogAdminReplayReapplyImpactSummaryReadModel,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
} from "./admin-control-plane-read-model-contracts";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import type { ProviderAdapter, ProviderUsageEstimate } from "./provider-adapters/provider-adapter";
import type { ProviderOptionAliasRecord } from "./provider-option-aliases";
import { type CatalogProviderOptionQueryPage } from "./provider-option-query-cache";
import { type CatalogControlPlaneTelemetryEventInput } from "./catalog-integration-observability";
import { type CatalogProviderDuplicatePreventionEvidenceSummary } from "./provider-duplicate-prevention-resolver";

export type CatalogProviderIntegrationProfileVersionReader = Pick<
  CatalogProviderIntegrationProfileVersionStore,
  "listProfileVersions" | "getActiveProfileVersion"
>;

export function catalogProviderProfileVersionLookupKey(
  providerKey: string,
  profileKey: string,
  profileVersion: string,
): string {
  return `${providerKey.trim().toLowerCase()}\u0000${profileKey.trim().toLowerCase()}\u0000${profileVersion.trim()}`;
}

export const staticCatalogProviderIntegrationProfileVersions: CatalogProviderIntegrationProfileVersionReader = {
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

export type SourceObservationProgressHandler = (progress: BulkSourceObservationProgress) => void | Promise<void>;

export type DurableSideEffectRunner = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export type SourceObservationRecordInput = Omit<
  Extract<SourceObservationCommand, { type: "RecordSourceObservation" }>,
  "type"
>;

export type SourceObservationBulkJobAction = "promote" | "reject" | "defer" | "reapply";

export type SourceObservationBulkJobStatus = "queued" | "running" | "completed" | "failed";

export type SourceObservationBulkJobPayload = Readonly<{
  action: SourceObservationBulkJobAction;
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: SourceObservationFilterScope;
  reason: string | null;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

export type SourceObservationBulkWorkUnitPayload = Readonly<{
  observationId: string;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

export type SourceObservationBulkWorkUnitResult =
  | BulkSourceObservationPromotionOutcome
  | BulkSourceObservationReapplyOutcome;

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

export type SourceObservationIntegrationJobPayload = Readonly<{
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

export type SourceObservationIntegrationWorkUnitPayload = Readonly<{
  observationId: string;
  profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
}>;

export type ProviderAdapterIntegrationImportTarget = Readonly<{
  targetId: string;
  name: string;
  scopeKey: string;
  values: Readonly<Record<string, string>>;
  languageCode: string;
}>;

export type ProviderIntegrationImportTargetOptionScope = "expansion" | "set-name";

export type ProviderAdapterImportProgress = Readonly<{
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

export type SourceObservationIntegrationDurableJobRecord = DurableJobRecord<
  SourceObservationIntegrationJobPayload,
  BulkSourceObservationProgress,
  SourceObservationIntegrationJobResult
>;

export type CatalogSyncRunPayload = Readonly<{
  runVersion: "catalog-sync-run-v1";
  idempotencyKey: string;
  scope: CatalogSyncScope;
  selectedUnits: readonly CatalogSyncRunSelectedUnitSnapshot[];
  preview: CatalogSyncProviderParticipationPreview;
}>;

export type CatalogSyncRunFanoutProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentName: string | null;
  status: "child-job-enqueued" | "child-job-failed" | null;
}>;

export type CatalogSyncRunFanoutResult = Readonly<{
  childJobs: readonly CatalogSyncRunChildJobLink[];
}>;

export type CatalogSyncRunDurableJobRecord = DurableJobRecord<
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

export const OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE = "Operator cancelled provider import job.";

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

export type SourceObservationPromotionTargetResult = Readonly<{
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

export type SourceObservationAliasCandidateSink = (
  candidates: readonly CatalogAliasCandidate[],
  observedAt: string,
) => Promise<void>;

export type SourceObservationAliasPromotion =
  | PromotionAliasServices
  | Readonly<{ catalogAliasCommandHandler: PromotionAliasServices["catalogAliasCommandHandler"] }>;
