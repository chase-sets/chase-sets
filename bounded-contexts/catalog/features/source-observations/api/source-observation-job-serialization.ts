import { createHash } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  DurableJobHandoffError,
  runDurableJobSideEffect,
  type DurableJobEvent,
  type DurableJobExecutionContext,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  type DurableJobStatus,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  isDurableJobWorkUnitTerminalAccepted,
  type DurableJobWorkUnitClaim,
  type DurableJobWorkUnitTerminalOutcome,
  type DurableJobWorkUnitStore,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import {
  type CatalogScopeSyncScopeDescriptor,
  type CatalogScopeSyncUnitObservedStatus,
} from "../../scope-sync-state/domain/state";
import { type SourceObservationFilterScope } from "../read-model/queries";
import { type CatalogProviderProfileVersionSelector } from "./provider-integration-profiles";
import { type CatalogSyncProviderParticipationPreview, type CatalogSyncScope } from "./catalog-sync-scope-planner";
import type { ProviderImportPlan } from "./provider-adapters/provider-adapter";
import { OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE } from "./source-observation-runtime-contracts";
import type {
  SourceObservationBulkJob,
  SourceObservationIntegrationJob,
  SourceObservationBulkJobPayload,
  BulkSourceObservationProgress,
  SourceObservationBulkJobResult,
  SourceObservationBulkWorkUnitPayload,
  SourceObservationBulkWorkUnitResult,
  SourceObservationIntegrationJobPayload,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationDurableJobRecord,
  SourceObservationIntegrationJobOperatorStatus,
  CatalogSyncRunDurableJobRecord,
  CatalogSyncRunFanoutProgress,
  CatalogSyncRunFanoutResult,
  CatalogSyncRunSelectedUnitSnapshot,
  CatalogSyncRunChildJobLink,
  CatalogSyncRunChildStatus,
  SourceObservationIntegrationJobScope,
  CatalogSyncRunChildJob,
  CatalogSyncRunProgress,
  CatalogSyncRunOperatorStatus,
  SourceObservationJobEvent,
  SourceObservationPromotionOutcomeRecord,
  SourceObservationBulkJobAction,
  BulkSourceObservationPromotionOutcome,
  BulkSourceObservationPromotionResult,
  BulkSourceObservationReapplyOutcome,
  BulkSourceObservationReapplyResult,
  DurableSideEffectRunner,
  SourceObservationJobRunContext,
  SourceObservationIntegrationJobOutcome,
  SourceObservationIntegrationImportPreviewTarget,
  SourceObservationProviderUsageEvidence,
} from "./source-observation-runtime-contracts";
import { normalizeReapplyProfileMode } from "./catalog-integration-control-plane-readiness";

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

export type ClaimedSourceObservationBulkJob = SourceObservationBulkJob &
  Readonly<{
    eventContext: EventStoreContext;
    claimOwnerId: string;
  }>;

export type ClaimedSourceObservationIntegrationJob = SourceObservationIntegrationJob &
  Readonly<{
    eventContext: EventStoreContext;
    claimOwnerId: string;
  }>;

export function toSourceObservationBulkJob(
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

export function toSourceObservationBulkJobEventSnapshot(
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

export function toClaimedSourceObservationBulkJob(
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

export function toClaimedSourceObservationBulkJobFromWorkUnitClaim(
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

export function toSourceObservationIntegrationJob(
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

export function integrationJobOperatorStatus(
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

export const reusableActiveIntegrationJobOperatorStatuses = new Set<SourceObservationIntegrationJobOperatorStatus>([
  "queued",
  "running",
]);

export function integrationJobCompletedOperatorStatus(
  job: SourceObservationIntegrationDurableJobRecord,
): SourceObservationIntegrationJobOperatorStatus {
  if (job.result && job.result.failed > 0) {
    return "partial";
  }

  return "completed";
}

export function integrationJobHasActiveProgress(job: SourceObservationIntegrationDurableJobRecord): boolean {
  return job.status === "running" || (job.status === "queued" && job.progress.phase !== "queued");
}

export function isOperatorCancelledIntegrationJob(
  job: Readonly<{ status: DurableJobStatus; errorMessage: string | null }>,
) {
  return job.status === "failed" && job.errorMessage === OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE;
}

export function isDurableJobClaimExpired(job: Readonly<{ claimedUntil: string | null }>) {
  if (!job.claimedUntil) {
    return true;
  }

  const claimedUntil = Date.parse(job.claimedUntil);
  return !Number.isFinite(claimedUntil) || claimedUntil <= Date.now();
}

export function retryableIntegrationJobResult(
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

export function toSourceObservationIntegrationJobEventSnapshot(
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

export function toCatalogSyncRunFanoutEventSnapshot(
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

export function selectedCatalogSyncRunUnits(
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

export function catalogSyncRunIdempotencyKey(
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

export function catalogSyncRunFanoutProgress(
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

export function catalogSyncRunChildStatus(
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

export function catalogScopeSyncStateDescriptor(scope: CatalogSyncScope): CatalogScopeSyncScopeDescriptor {
  return {
    productDomain: scope.productDomain,
    productForm: scope.productForm ?? null,
    languageCode: scope.languageCode ?? null,
    referenceKind: scope.reference.kind,
    scopeRecordId: scope.reference.scopeRecordId,
  };
}

export function compactStringRecord(
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

export function recordFromUnknownStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function catalogScopeSyncObservedStatusFromChildLink(
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

export function childExecutionScopesMatch(
  a: SourceObservationIntegrationJobScope,
  b: SourceObservationIntegrationJobScope,
): boolean {
  return JSON.stringify(normalizeIntegrationJobScope(a)) === JSON.stringify(normalizeIntegrationJobScope(b));
}

export function catalogSyncRunProgress(
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

export function catalogSyncRunOperatorStatus(
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

export function isCatalogSyncRunTerminalChild(childJob: CatalogSyncRunChildJob): boolean {
  return (
    childJob.status === "completed" ||
    childJob.status === "partial" ||
    childJob.status === "failed" ||
    childJob.status === "cancelled"
  );
}

export function toClaimedSourceObservationIntegrationJob(
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

export function toSourceObservationJobEvent<TJob>(
  event: DurableJobEvent<unknown, BulkSourceObservationProgress, unknown, TJob>,
): SourceObservationJobEvent<TJob> {
  return {
    sequence: event.sequence,
    eventName: event.eventName,
    job: event.job,
    createdAt: event.createdAt,
  };
}

export function terminalPromotionOutcomeFromEvents(
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

export async function requireSourceObservationJobClaim(
  succeeded: Promise<boolean | DurableJobWorkUnitTerminalOutcome> | boolean | DurableJobWorkUnitTerminalOutcome,
) {
  const outcome = await succeeded;
  if (!isDurableJobWorkUnitTerminalAccepted(outcome)) {
    throw new Error("Source Observation job claim was lost before the status update completed.");
  }
}

export function sourceObservationRetentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

export function jobMatchesContext(
  job: Readonly<{ eventContext: EventStoreContext | null }>,
  context: EventStoreContext,
): boolean {
  return (
    job.eventContext?.tenantId === context.tenantId &&
    job.eventContext?.audit?.forAccountId === context.audit?.forAccountId &&
    job.eventContext?.audit?.performedByUserId === context.audit?.performedByUserId
  );
}

export function isImpactBlockingJob(
  status: string,
  action: "import" | "reapply" | SourceObservationBulkJobAction,
): boolean {
  return action !== "reject" && action !== "defer" && (status === "queued" || status === "running");
}

export function impactJobProviderKey(job: SourceObservationIntegrationJob): string | null {
  return job.profileSnapshot?.providerKey ?? job.scope.provider ?? null;
}

export function parseJsonField<T>(value: unknown, fieldName: string): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  if (value && typeof value === "object") {
    return value as T;
  }

  throw new Error(`Bulk review job ${fieldName} is not valid JSON.`);
}

export function formatDateLike(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function normalizeBulkJobScope(scope: SourceObservationFilterScope): SourceObservationFilterScope {
  return {
    search: scope.search?.trim() || undefined,
    status: scope.status?.trim() || undefined,
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
  };
}

export function normalizeIntegrationJobScope(
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

export function normalizeOptionalKey(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeCandidateGenerationScope(
  scope: SourceObservationFilterScope,
  syncRunId: string | null,
): SourceObservationFilterScope {
  return {
    ...scope,
    syncRunId: syncRunId ?? scope.syncRunId,
  };
}

export function stableJsonStringify(value: unknown): string {
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

export function profileSelectorFromScope(
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

export function integrationScopeToObservationScope(
  scope: SourceObservationIntegrationJobScope,
): SourceObservationFilterScope {
  return {
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    productLineId: scope.productLineId?.trim() || undefined,
    seriesId: scope.seriesId?.trim() || undefined,
    expansionId: scope.setId?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
  };
}

export function uniqueObservationIds(observationIds: readonly string[]): string[] {
  return Array.from(
    new Set(
      observationIds.map((observationId) => observationId.trim()).filter((observationId) => observationId.length > 0),
    ),
  );
}

export function summarizePromotionOutcomes(
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

export function summarizeReapplyOutcomes(
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

export function bulkResultOutcomes(
  result: SourceObservationBulkJobResult | null,
): readonly SourceObservationBulkWorkUnitResult[] {
  return result?.outcomes ?? [];
}

export function isPromotionOutcome(
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

export function isReapplyOutcome(
  outcome: SourceObservationBulkWorkUnitResult,
): outcome is BulkSourceObservationReapplyOutcome {
  return outcome.status === "reapplied" || outcome.status === "skipped" || outcome.status === "failed";
}

export function workUnitTerminalState(
  outcome: SourceObservationBulkWorkUnitResult,
): "completed" | "failed" | "skipped" {
  if (outcome.status === "failed") {
    return "failed";
  }
  if (outcome.status === "skipped") {
    return "skipped";
  }
  return "completed";
}

export function failedBulkWorkUnitOutcome(
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

export class SourceObservationJobCancelledError extends Error {
  constructor() {
    super("Source Observation job run was cancelled.");
  }
}

export function createSourceObservationSideEffectRunner<TResult>(
  jobContext: DurableJobExecutionContext<BulkSourceObservationProgress, TResult>,
): DurableSideEffectRunner {
  return (work) =>
    runDurableJobSideEffect(jobContext, work, {
      renewIntervalMs: 5_000,
      claimLostMessage: "Source Observation job claim was lost while applying a side effect.",
    });
}

export function createSourceObservationWorkUnitSideEffectRunner<
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

export function runSourceObservationSideEffectImmediately<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return work(new AbortController().signal);
}

export function isJobRunCancelled(context: SourceObservationJobRunContext): boolean {
  return context.signal?.aborted ?? false;
}

export function throwIfJobRunCancelled(context: SourceObservationJobRunContext): void {
  if (context.signal?.aborted) {
    throw new SourceObservationJobCancelledError();
  }

  try {
    context.throwIfLeaseLost?.();
  } catch (error) {
    throw new SourceObservationJobCancelledError();
  }
}

export function summarizeIntegrationJobOutcomes(
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

export function integrationImportPreviewTargetFromPlan(input: {
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

export function providerUsageEvidenceFromImportPlan(
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

export function integrationReapplyOutcomeFromBulkOutcome(
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

export function bulkProgress(
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
