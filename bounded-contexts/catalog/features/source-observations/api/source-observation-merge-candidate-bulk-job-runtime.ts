import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { isDurableJobHandoffError, type DurableJobRecord } from "@chase-sets/platform-runtime/durable-job-store";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import {
  catalogMergeCandidateAppliedModes,
  type CatalogMergeCandidateAppliedMode,
  type CatalogMergeCandidateStatus,
} from "../domain/catalog-merge-candidate";
import { listCatalogMergeCandidateIdsForScope } from "../read-model/queries";
import type { CatalogIntegrationRolloutControlPolicy } from "./governance/catalog-integration-rollout-controls";
import {
  applyCatalogMergeCandidatePromotion,
  CatalogMergeCandidateApplicationError,
  unappliedOutcome,
  type CatalogMergeCandidateApplicationPorts,
} from "./promotion/catalog-merge-candidate-application";
import { retainProviderSendJobBinding, runProviderSendJob } from "./providers/provider-send-runtime";
import { recordBulkReviewWorkUnitTelemetry } from "./providers/provider-option-queries";
import {
  bulkProgress,
  createSourceObservationWorkUnitSideEffectRunner,
  formatDateLike,
  isJobRunCancelled,
  jobMatchesContext,
  parseJsonField,
  requireSourceObservationJobClaim,
  SourceObservationJobCancelledError,
  throwIfJobRunCancelled,
} from "./source-observation-job-serialization";
import type { SourceObservationMergeCandidateRuntime } from "./source-observation-merge-candidate-runtime";
import { catalogMergeCandidateReviewActor } from "./source-observation-stream-identity";
import {
  catalogMergeCandidateBulkJobKinds,
  catalogMergeCandidatePromotionApplicationVersion,
  type BulkSourceObservationProgress,
  type CatalogProviderIntegrationProfileVersionReader,
  type CatalogMergeCandidateBulkJob,
  type CatalogMergeCandidateBulkJobKind,
  type CatalogMergeCandidateBulkJobPage,
  type CatalogMergeCandidateBulkJobPayload,
  type CatalogMergeCandidateBulkJobResult,
  type CatalogMergeCandidateBulkJobServices,
  type CatalogMergeCandidateBulkJobStore,
  type CatalogMergeCandidateBulkUnitResult,
  type CatalogMergeCandidateBulkWorkUnitStore,
} from "./source-observation-runtime-contracts";

export const catalogMergeCandidateBulkJobPageSize = 50;

const missingWorkUnitGraceMs = 5 * 60_000;

/**
 * Version-1 scope promotion jobs persist under their own stored kind. A
 * pre-application worker claims only the stored kinds it knows, so it can never
 * claim a version-1 job and report approval as completed application. The
 * public `kind` stays `merge-candidate-promote`; `promotionApplicationVersion`
 * distinguishes it on every read.
 */
export const catalogMergeCandidatePromotionApplicationJobKind = "merge-candidate-promote-application-v1";
const legacyPromotionJobKind = "merge-candidate-promote";

const storedJobKinds: readonly string[] = [
  catalogMergeCandidatePromotionApplicationJobKind,
  legacyPromotionJobKind,
  "merge-candidate-defer",
];

function storedJobKindsFor(kind: CatalogMergeCandidateBulkJobKind | null | undefined): readonly string[] {
  if (kind === "merge-candidate-promote")
    return [legacyPromotionJobKind, catalogMergeCandidatePromotionApplicationJobKind];
  return kind ? [kind] : storedJobKinds;
}

// A job enumerates every candidate in the scope that could still need its
// action as a work unit, and each unit decides from the candidate's stream
// whether its candidate matches the job when it runs. Promotion also enumerates
// approved candidates: an approved candidate without a completed application
// is catch-up work, while an applied one is skipped. Defer-remainder takes the
// candidates that still need a disposition. Every other candidate is left
// untouched and counted as skipped-not-eligible.
const enumeratedStatuses: Readonly<Record<CatalogMergeCandidateBulkJobKind, readonly CatalogMergeCandidateStatus[]>> = {
  "merge-candidate-promote": ["ready", "has-conflicts", "stale", "deferred", "promoted"],
  "merge-candidate-defer": ["ready", "has-conflicts", "stale", "deferred"],
};

const deferEligibleStatuses: readonly CatalogMergeCandidateStatus[] = ["has-conflicts", "stale"];

const defaultReasons: Readonly<Record<CatalogMergeCandidateBulkJobKind, string>> = {
  "merge-candidate-promote": "Promote all ready candidates in the scope.",
  "merge-candidate-defer": "Defer the remaining candidates in the scope.",
};

export class CatalogMergeCandidateBulkJobCursorError extends Error {
  constructor() {
    super("Catalog Merge Candidate bulk job cursor is invalid.");
  }
}

export function isCatalogMergeCandidateBulkJobKind(value: unknown): value is CatalogMergeCandidateBulkJobKind {
  return typeof value === "string" && (catalogMergeCandidateBulkJobKinds as readonly string[]).includes(value);
}

/** A retained job record whose version discriminator or version-1 results are invalid; readers fail closed. */
export class CatalogMergeCandidateBulkJobMalformedError extends Error {
  constructor(jobId: string, detail: string) {
    super(`Catalog Merge Candidate bulk job ${jobId} is malformed: ${detail}`);
    this.name = "CatalogMergeCandidateBulkJobMalformedError";
  }
}

export type SourceObservationMergeCandidateBulkJobRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  jobStore: CatalogMergeCandidateBulkJobStore;
  workUnitStore: CatalogMergeCandidateBulkWorkUnitStore;
  mergeCandidates: Pick<
    SourceObservationMergeCandidateRuntime,
    "loadCatalogMergeCandidateForReview" | "applyCatalogMergeCandidateReviewAtVersion"
  >;
  referenceData: ReferenceDataServices;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  rolloutControlPolicy: Pick<CatalogIntegrationRolloutControlPolicy, "assertAllowed">;
}>;

/**
 * Scope-wide Catalog Merge Candidate review jobs on the bulk review runner. A
 * job enumerates one work unit per scope candidate at start; each unit re-checks
 * its candidate's aggregate state at the checked version, so retries and
 * resumes collapse to one terminal outcome per candidate. Promotion units apply
 * the approved candidate through its immutable plan checkpoint and report
 * `promoted` only after the application is recorded.
 */
export function createSourceObservationMergeCandidateBulkJobRuntime({
  deps,
  jobStore,
  workUnitStore,
  mergeCandidates,
  referenceData,
  profileVersions,
  rolloutControlPolicy,
}: SourceObservationMergeCandidateBulkJobRuntimeDeps) {
  const applicationPorts: CatalogMergeCandidateApplicationPorts = {
    deps,
    referenceData,
    profileVersions,
    rolloutControlPolicy,
    applyCandidateCommandAtVersion: (input) => mergeCandidates.applyCatalogMergeCandidateReviewAtVersion(input),
  };

  async function enqueueCatalogMergeCandidateBulkJob(input: {
    kind: CatalogMergeCandidateBulkJobKind;
    scopeRecordId: string;
    reason?: string | null;
    context: EventStoreContext;
  }): Promise<CatalogMergeCandidateBulkJob> {
    const scopeRecordId = input.scopeRecordId.trim();
    if (!scopeRecordId) {
      throw new Error("Catalog Merge Candidate bulk jobs require a scope record ID.");
    }
    const reason = input.reason?.trim() || defaultReasons[input.kind];
    const candidateIds = await listCatalogMergeCandidateIdsForScope(deps.db, {
      scopeRecordId,
      statuses: enumeratedStatuses[input.kind],
    });
    const applies = input.kind === "merge-candidate-promote";
    const storedKind = applies ? catalogMergeCandidatePromotionApplicationJobKind : input.kind;
    const jobId = createId("job");
    await retainProviderSendJobBinding(deps, jobId);
    const job = await jobStore.enqueue({
      jobId,
      jobKind: storedKind,
      payload: applies
        ? { scopeRecordId, reason, promotionApplicationVersion: catalogMergeCandidatePromotionApplicationVersion }
        : { scopeRecordId, reason },
      progress: bulkProgress(0, candidateIds.length, null, null, "queued"),
      eventContext: input.context,
    });
    await workUnitStore.enqueue({
      jobId,
      units: candidateIds.map((candidateId) => ({
        unitId: candidateId,
        unitKind: storedKind,
        payload: { candidateId },
      })),
    });

    return toCatalogMergeCandidateBulkJob(job);
  }

  async function processNextCatalogMergeCandidateBulkJob(
    input: Parameters<CatalogMergeCandidateBulkJobServices["processNextCatalogMergeCandidateBulkJob"]>[0],
  ): Promise<number> {
    if (isJobRunCancelled(input)) {
      return 0;
    }

    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: storedJobKinds,
      laneName: input.laneName ?? null,
    });
    if (!claimResult.claim) {
      return reconcileTerminalCatalogMergeCandidateBulkJobs();
    }
    const claim = claimResult.claim;
    const job = toCatalogMergeCandidateBulkJob(claim.job);
    const candidateId = claim.unit.payload.candidateId;
    const context = claim.job.eventContext;

    try {
      if (!context) {
        throw new Error("Catalog Merge Candidate bulk job is missing claim context.");
      }
      throwIfJobRunCancelled(input);
      const runSideEffect = createSourceObservationWorkUnitSideEffectRunner(workUnitStore, claim, {
        signal: input.signal,
        throwIfLeaseLost: input.throwIfLeaseLost,
        claimTtlMs: input.claimTtlMs,
      });
      const outcome = await runProviderSendJob(deps, job.jobId, () =>
        runSideEffect(() => reviewCandidate(job, claim.unit.unitId, candidateId, context)),
      );
      throwIfJobRunCancelled(input);

      const terminalState = unitTerminalState(outcome);
      await requireSourceObservationJobClaim(
        workUnitStore.recordTerminal({
          jobId: job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: terminalState,
          unitResult: outcome,
          errorMessage: outcome.status === "failed" ? outcome.reason : null,
          parentProgress: job.progress,
          parentResult: job.result,
          resolveParentUpdate: (queryable) => parentUpdateFromWorkUnits(queryable, job),
        }),
      );
      recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, job.kind, terminalState);
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        await workUnitStore.releaseClaim({
          jobId: job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        recordBulkReviewWorkUnitTelemetry(
          deps.sourceObservationTelemetry,
          job.kind,
          error instanceof SourceObservationJobCancelledError ? "cancelled" : "released",
        );
        return 0;
      }

      const reason = error instanceof Error ? error.message : "Catalog Merge Candidate bulk review failed.";
      const outcome: CatalogMergeCandidateBulkUnitResult =
        job.promotionApplicationVersion === catalogMergeCandidatePromotionApplicationVersion
          ? unappliedOutcome(
              candidateId,
              "failed",
              reason,
              error instanceof CatalogMergeCandidateApplicationError ? error.diagnosticCode : undefined,
            )
          : { candidateId, status: "failed", catalogItemId: null, reason };
      await requireSourceObservationJobClaim(
        workUnitStore.recordTerminal({
          jobId: job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: { ...job.progress, phase: "processing" },
          parentResult: job.result,
          resolveParentUpdate: (queryable) => parentUpdateFromWorkUnits(queryable, job),
        }),
      );
      recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, job.kind, "failed");
      return 1;
    }
  }

  // One candidate, re-checked against its aggregate when the unit runs.
  // Promotion applies through the candidate's own application checkpoints, so a
  // resumed unit recovers its result from the candidate stream. A deferral
  // resumed after its command was appended (but before its terminal was
  // recorded) recognizes its own job's review by the reason marker and reports
  // the same outcome instead of acting again.
  async function reviewCandidate(
    job: CatalogMergeCandidateBulkJob,
    unitId: string,
    candidateId: string,
    context: EventStoreContext,
  ): Promise<CatalogMergeCandidateBulkUnitResult> {
    const marker = bulkJobReasonMarker(job.jobId);
    if (job.kind === "merge-candidate-promote") {
      if (job.promotionApplicationVersion !== catalogMergeCandidatePromotionApplicationVersion) {
        // A retained approval-only job left queued across the cutover never runs;
        // only a new version-1 job may approve or apply.
        return {
          candidateId,
          status: "failed",
          catalogItemId: null,
          reason: "promotion-application-legacy-job: submit a new scope promotion job to apply approved candidates.",
        };
      }
      return applyCatalogMergeCandidatePromotion(applicationPorts, {
        candidateId,
        jobId: job.jobId,
        unitId,
        approvalReason: `${job.reason} ${marker}`,
        context,
      });
    }

    const { state, version } = await mergeCandidates.loadCatalogMergeCandidateForReview(candidateId);
    if (state.id === null || state.snapshot === null) {
      return skippedNotEligible(candidateId, "Catalog Merge Candidate was not found.");
    }
    if (state.status === "deferred" && state.statusReason?.endsWith(marker)) {
      return deferredOutcome(candidateId);
    }
    if (!deferEligibleStatuses.includes(state.status)) {
      return skippedNotEligible(candidateId, `Catalog Merge Candidate is ${state.status}.`);
    }

    await mergeCandidates.applyCatalogMergeCandidateReviewAtVersion({
      candidateId,
      command: {
        type: "DeferCatalogMergeCandidate",
        reason: `${job.reason} ${marker}`,
        actor: catalogMergeCandidateReviewActor(context),
        deferredAt: new Date().toISOString(),
      },
      expectedVersion: version,
      context,
    });
    return deferredOutcome(candidateId);
  }

  async function reconcileTerminalCatalogMergeCandidateBulkJobs(): Promise<number> {
    // Reconcile runs inside the shared bulk review worker loop, so a row of any
    // other kind is skipped rather than allowed to fail the loop.
    const activeJobs = (await jobStore.listActive({ jobKinds: storedJobKinds })).filter((job) =>
      storedJobKinds.includes(job.jobKind),
    );
    let reconciled = 0;
    for (const rawJob of activeJobs) {
      const summary = await workUnitStore.summarize({ jobId: rawJob.jobId });
      if (summary.queued > 0 || summary.running > 0 || summary.expiredClaims > 0) {
        continue;
      }

      const job = toCatalogMergeCandidateBulkJob(rawJob);
      const parentUpdate = await parentUpdateFromWorkUnits(deps.db, job);
      if (!parentUpdate.completeJob) {
        // Every unit is terminal yet fewer outcomes exist than candidates were
        // enumerated: units were lost after enqueue. Fail closed rather than
        // report a partial scope as complete. The grace period keeps a job whose
        // units are still being written by its enqueue from failing early.
        if (Date.parse(job.createdAt) > Date.now() - missingWorkUnitGraceMs) {
          continue;
        }
        const failed = await jobStore.cancel({
          jobId: job.jobId,
          progress: { ...parentUpdate.parentProgress, phase: "failed" },
          errorMessage: "Catalog Merge Candidate bulk job is missing enumerated work units.",
        });
        if (failed) {
          reconciled += 1;
          recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, job.kind, "failed");
        }
        continue;
      }

      const completed = await workUnitStore.reconcileTerminalParent({
        jobId: job.jobId,
        parentProgress: parentUpdate.parentProgress,
        parentResult: parentUpdate.parentResult,
        completeJob: true,
        resolveParentUpdate: (queryable) => parentUpdateFromWorkUnits(queryable, job),
      });
      if (completed) {
        reconciled += 1;
        recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, job.kind, "reconciled");
      }
    }

    return reconciled;
  }

  async function parentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: CatalogMergeCandidateBulkJob,
  ): Promise<
    Readonly<{
      parentProgress: BulkSourceObservationProgress;
      parentResult: CatalogMergeCandidateBulkJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await queryable.query<{ state: string; result: unknown }>(
      `SELECT state, result
       FROM catalog_source_observation_bulk_review_work_units
       WHERE job_id = $1
       ORDER BY created_at ASC, unit_id ASC`,
      [job.jobId],
    );
    const terminalUnits = units.rows.filter(
      (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
    );
    const outcomes = terminalUnits.flatMap((unit) =>
      unit.result == null ? [] : [parseJsonField<CatalogMergeCandidateBulkUnitResult>(unit.result, "work unit result")],
    );
    // The enqueue-time total is the enumerated candidate count; it never shrinks.
    const total = Math.max(job.progress.total, units.rows.length);
    const completeJob = terminalUnits.length === units.rows.length && outcomes.length >= total;
    const latestOutcome = outcomes.at(-1) ?? null;

    return {
      parentProgress: bulkProgress(
        outcomes.length,
        total,
        null,
        latestOutcome ? progressStatus(latestOutcome) : null,
        completeJob ? "completed" : "processing",
      ),
      parentResult: summarizeCatalogMergeCandidateBulkOutcomes(total, outcomes),
      completeJob,
    };
  }

  async function getCatalogMergeCandidateBulkJob(
    jobId: string,
    context?: EventStoreContext | null,
  ): Promise<CatalogMergeCandidateBulkJob | null> {
    const job = await jobStore.get(jobId);
    if (!job || !storedJobKinds.includes(job.jobKind) || (context && !jobMatchesContext(job, context))) {
      return null;
    }
    return toCatalogMergeCandidateBulkJob(job);
  }

  async function listActiveCatalogMergeCandidateBulkJobs(input: {
    context: EventStoreContext;
    scopeRecordId?: string | null;
    kind?: CatalogMergeCandidateBulkJobKind | null;
  }): Promise<readonly CatalogMergeCandidateBulkJob[]> {
    return listMatchingCatalogMergeCandidateBulkJobs(input, ["queued", "running"]);
  }

  async function listFailedCatalogMergeCandidateBulkJobs(
    input: Parameters<CatalogMergeCandidateBulkJobServices["listFailedCatalogMergeCandidateBulkJobs"]>[0],
  ): Promise<readonly CatalogMergeCandidateBulkJob[]> {
    return listMatchingCatalogMergeCandidateBulkJobs(input, ["failed"]);
  }

  async function listMatchingCatalogMergeCandidateBulkJobs(
    input: Parameters<CatalogMergeCandidateBulkJobServices["listActiveCatalogMergeCandidateBulkJobs"]>[0],
    statuses: readonly CatalogMergeCandidateBulkJob["status"][],
  ): Promise<readonly CatalogMergeCandidateBulkJob[]> {
    const order = statuses[0] === "failed" ? "DESC" : "ASC";
    const result = await deps.db.query<CandidateJobRow>(
      `SELECT job_id, job_kind, status, payload, progress, result, error_message,
              created_at, started_at, completed_at, updated_at
       FROM catalog_source_observation_bulk_review_jobs
       WHERE job_kind = ANY($1::text[])
         AND status = ANY($2::text[])
         AND ($3::text IS NULL OR payload->>'scopeRecordId' = $3::text)
         AND event_context->>'tenantId' = $4::text
         AND event_context->'audit'->>'forAccountId' = $5::text
         AND event_context->'audit'->>'performedByUserId' = $6::text
       ORDER BY created_at ${order}, job_id ${order}
       LIMIT $7`,
      [
        [...storedJobKindsFor(input.kind)],
        statuses,
        input.scopeRecordId?.trim() || null,
        String(input.context.tenantId),
        String(input.context.audit.forAccountId),
        String(input.context.audit.performedByUserId),
        catalogMergeCandidateBulkJobPageSize,
      ],
    );
    return result.rows.map(candidateJobRowToCatalogMergeCandidateBulkJob);
  }

  // Newest-first keyset over (completed_at, job_id). The cursor carries the
  // exact microsecond completion time of the last row, so ties and sub-
  // millisecond completions still page every job exactly once.
  async function listCompletedCatalogMergeCandidateBulkJobs(input: {
    context: EventStoreContext;
    scopeRecordId?: string | null;
    kind?: CatalogMergeCandidateBulkJobKind | null;
    cursor?: string | null;
  }): Promise<CatalogMergeCandidateBulkJobPage> {
    const after = input.cursor ? decodeCompletedJobCursor(input.cursor) : null;
    const result = await deps.db.query<CompletedJobRow>(
      `SELECT job_id,
              job_kind,
              status,
              payload,
              progress,
              result,
              error_message,
              created_at,
              started_at,
              completed_at,
              updated_at,
              to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_key
       FROM catalog_source_observation_bulk_review_jobs
       WHERE job_kind = ANY($1::text[])
         AND status = 'completed'
         AND completed_at IS NOT NULL
         AND ($2::text IS NULL OR payload->>'scopeRecordId' = $2::text)
         AND event_context->>'tenantId' = $3::text
         AND event_context->'audit'->>'forAccountId' = $4::text
         AND event_context->'audit'->>'performedByUserId' = $5::text
         AND ($6::timestamptz IS NULL OR (completed_at, job_id) < ($6::timestamptz, $7::text))
       ORDER BY completed_at DESC, job_id DESC
       LIMIT $8`,
      [
        [...storedJobKindsFor(input.kind)],
        input.scopeRecordId?.trim() || null,
        String(input.context.tenantId),
        String(input.context.audit.forAccountId),
        String(input.context.audit.performedByUserId),
        after?.completedAt ?? null,
        after?.jobId ?? null,
        catalogMergeCandidateBulkJobPageSize + 1,
      ],
    );
    const rows = result.rows.slice(0, catalogMergeCandidateBulkJobPageSize);
    const last = rows.at(-1);
    const items = rows.map(candidateJobRowToCatalogMergeCandidateBulkJob);

    return result.rows.length > catalogMergeCandidateBulkJobPageSize && last
      ? { items, cursor: encodeCompletedJobCursor({ completedAt: last.completed_at_key, jobId: last.job_id }) }
      : { items };
  }

  const services: CatalogMergeCandidateBulkJobServices = {
    enqueueCatalogMergeCandidateBulkJob,
    getCatalogMergeCandidateBulkJob,
    listActiveCatalogMergeCandidateBulkJobs,
    listCompletedCatalogMergeCandidateBulkJobs,
    listFailedCatalogMergeCandidateBulkJobs,
    processNextCatalogMergeCandidateBulkJob,
  };

  return { services };
}

export type SourceObservationMergeCandidateBulkJobRuntime = ReturnType<
  typeof createSourceObservationMergeCandidateBulkJobRuntime
>;

type CandidateJobRow = Readonly<{
  job_id: string;
  job_kind: string;
  status: CatalogMergeCandidateBulkJob["status"];
  payload: unknown;
  progress: unknown;
  result: unknown;
  error_message: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  updated_at: Date | string;
}>;

type CompletedJobRow = CandidateJobRow & Readonly<{ completed_at_key: string }>;

export function toCatalogMergeCandidateBulkJob(
  job: DurableJobRecord<
    CatalogMergeCandidateBulkJobPayload,
    BulkSourceObservationProgress,
    CatalogMergeCandidateBulkJobResult
  >,
): CatalogMergeCandidateBulkJob {
  const discriminator = readCatalogMergeCandidateBulkJobDiscriminator(job.jobId, job.jobKind, job.payload);
  return {
    jobId: job.jobId,
    ...discriminator,
    scopeRecordId: job.payload.scopeRecordId,
    reason: job.payload.reason,
    status: job.status,
    progress: job.progress,
    result: requireCatalogMergeCandidateBulkJobResult(job.jobId, discriminator.promotionApplicationVersion, job.result),
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

export function toCatalogMergeCandidateBulkJobEventSnapshot(
  job: DurableJobRecord<
    CatalogMergeCandidateBulkJobPayload,
    BulkSourceObservationProgress,
    CatalogMergeCandidateBulkJobResult
  >,
): CatalogMergeCandidateBulkJob {
  const snapshot = toCatalogMergeCandidateBulkJob(job);
  return snapshot.status === "completed" || snapshot.status === "failed" ? snapshot : { ...snapshot, result: null };
}

export function summarizeCatalogMergeCandidateBulkOutcomes(
  requested: number,
  outcomes: readonly CatalogMergeCandidateBulkUnitResult[],
): CatalogMergeCandidateBulkJobResult {
  return {
    requested,
    promoted: outcomes.filter((outcome) => outcome.status === "promoted").length,
    deferred: outcomes.filter((outcome) => outcome.status === "deferred").length,
    skippedNotEligible: outcomes.filter((outcome) => outcome.status === "skipped-not-eligible").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}

function candidateJobRowToCatalogMergeCandidateBulkJob(row: CandidateJobRow): CatalogMergeCandidateBulkJob {
  const payload = parseJsonField<CatalogMergeCandidateBulkJobPayload>(row.payload, "payload");
  const discriminator = readCatalogMergeCandidateBulkJobDiscriminator(row.job_id, row.job_kind, payload);
  return {
    jobId: row.job_id,
    ...discriminator,
    scopeRecordId: payload.scopeRecordId,
    reason: payload.reason,
    status: row.status,
    progress: parseJsonField<BulkSourceObservationProgress>(row.progress, "progress"),
    result: requireCatalogMergeCandidateBulkJobResult(
      row.job_id,
      discriminator.promotionApplicationVersion,
      row.result == null ? null : parseJsonField<CatalogMergeCandidateBulkJobResult>(row.result, "result"),
    ),
    errorMessage: row.error_message,
    createdAt: formatDateLike(row.created_at),
    startedAt: row.started_at == null ? null : formatDateLike(row.started_at),
    completedAt: row.completed_at == null ? null : formatDateLike(row.completed_at),
    updatedAt: formatDateLike(row.updated_at),
  };
}

/**
 * Map a stored job kind to its public kind and application version. Retained
 * legacy promotion jobs stay readable as version-null; a payload whose
 * discriminator disagrees with its stored kind fails closed.
 */
function readCatalogMergeCandidateBulkJobDiscriminator(
  jobId: string,
  storedKind: string,
  payload: CatalogMergeCandidateBulkJobPayload,
): Pick<CatalogMergeCandidateBulkJob, "kind" | "promotionApplicationVersion"> {
  const version = (payload as Readonly<Record<string, unknown>>).promotionApplicationVersion;
  if (storedKind === catalogMergeCandidatePromotionApplicationJobKind) {
    if (version !== catalogMergeCandidatePromotionApplicationVersion)
      throw new CatalogMergeCandidateBulkJobMalformedError(jobId, "missing promotionApplicationVersion 1");
    return { kind: "merge-candidate-promote", promotionApplicationVersion: version };
  }
  if (!isCatalogMergeCandidateBulkJobKind(storedKind)) {
    throw new Error(`Bulk review job kind '${storedKind}' is not a Catalog Merge Candidate bulk job.`);
  }
  if (version !== undefined)
    throw new CatalogMergeCandidateBulkJobMalformedError(jobId, "unexpected promotionApplicationVersion");
  return { kind: storedKind, promotionApplicationVersion: null };
}

/** Version-1 results must carry completion facts exactly when promoted; legacy results are returned as stored. */
function requireCatalogMergeCandidateBulkJobResult(
  jobId: string,
  version: CatalogMergeCandidateBulkJob["promotionApplicationVersion"],
  result: CatalogMergeCandidateBulkJobResult | null,
): CatalogMergeCandidateBulkJobResult | null {
  if (result === null || version === null) return result;
  for (const outcome of result.outcomes) {
    if (!isWellFormedApplicationOutcome(outcome))
      throw new CatalogMergeCandidateBulkJobMalformedError(
        jobId,
        `invalid application result for ${outcome.candidateId}`,
      );
  }
  const summary = summarizeCatalogMergeCandidateBulkOutcomes(result.requested, result.outcomes);
  if (
    summary.promoted !== result.promoted ||
    summary.deferred !== result.deferred ||
    summary.skippedNotEligible !== result.skippedNotEligible ||
    summary.failed !== result.failed
  )
    throw new CatalogMergeCandidateBulkJobMalformedError(jobId, "result counts disagree with its outcomes");
  return result;
}

function isWellFormedApplicationOutcome(outcome: CatalogMergeCandidateBulkUnitResult): boolean {
  if (outcome.diagnosticCode !== undefined && outcome.diagnosticCode !== "asset-processing-failed") return false;
  if (outcome.status === "promoted") {
    return (
      typeof outcome.appliedCatalogItemId === "string" &&
      outcome.appliedCatalogItemId.length > 0 &&
      catalogMergeCandidateAppliedModes.includes(outcome.appliedMode as CatalogMergeCandidateAppliedMode) &&
      Number.isSafeInteger(outcome.approvalVersion) &&
      (outcome.approvalVersion ?? 0) > 0 &&
      typeof outcome.planFingerprint === "string" &&
      outcome.planFingerprint.length > 0 &&
      outcome.diagnosticCode === undefined
    );
  }
  return (
    outcome.status !== "deferred" &&
    outcome.appliedCatalogItemId === null &&
    outcome.appliedMode === null &&
    outcome.approvalVersion === null &&
    outcome.planFingerprint === null
  );
}

export type CatalogMergeCandidateApplicationReconciliation = Readonly<{
  /** One completed application per candidate, however many jobs or retries reported it. */
  applied: ReadonlyMap<
    string,
    Readonly<{
      catalogItemId: string;
      appliedMode: CatalogMergeCandidateAppliedMode;
      approvalVersion: number;
      planFingerprint: string;
    }>
  >;
  /** Candidates whose only promoted outcomes are legacy approvals: catch-up work, never settled. */
  approvalOnly: ReadonlySet<string>;
}>;

/**
 * Reconcile the complete promotion history of a scope by candidate. Callers
 * pass every completed promotion job (all pages); a version-1 application is
 * counted once however many units reported it, a conflicting application id,
 * mode or plan fails closed, and a legacy approval-only outcome never supplies
 * an id or a count.
 */
export function reconcileCatalogMergeCandidateApplications(
  jobs: readonly CatalogMergeCandidateBulkJob[],
): CatalogMergeCandidateApplicationReconciliation {
  const applied = new Map<
    string,
    Readonly<{
      catalogItemId: string;
      appliedMode: CatalogMergeCandidateAppliedMode;
      approvalVersion: number;
      planFingerprint: string;
    }>
  >();
  const legacyPromoted = new Set<string>();
  for (const job of jobs) {
    if (job.kind !== "merge-candidate-promote") continue;
    for (const outcome of job.result?.outcomes ?? []) {
      if (outcome.status !== "promoted") continue;
      if (job.promotionApplicationVersion === null) {
        legacyPromoted.add(outcome.candidateId);
        continue;
      }
      if (!isWellFormedApplicationOutcome(outcome))
        throw new CatalogMergeCandidateBulkJobMalformedError(
          job.jobId,
          `invalid application result for ${outcome.candidateId}`,
        );
      const facts = {
        catalogItemId: outcome.appliedCatalogItemId!,
        appliedMode: outcome.appliedMode!,
        approvalVersion: outcome.approvalVersion!,
        planFingerprint: outcome.planFingerprint!,
      };
      const previous = applied.get(outcome.candidateId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(facts))
        throw new CatalogMergeCandidateBulkJobMalformedError(
          job.jobId,
          `conflicting applications reported for ${outcome.candidateId}`,
        );
      applied.set(outcome.candidateId, facts);
    }
  }
  return { applied, approvalOnly: new Set([...legacyPromoted].filter((candidateId) => !applied.has(candidateId))) };
}

export function bulkJobReasonMarker(jobId: string): string {
  return `(bulk job ${jobId})`;
}

function deferredOutcome(candidateId: string): CatalogMergeCandidateBulkUnitResult {
  return { candidateId, status: "deferred", catalogItemId: null, reason: null };
}

function skippedNotEligible(candidateId: string, reason: string): CatalogMergeCandidateBulkUnitResult {
  return { candidateId, status: "skipped-not-eligible", catalogItemId: null, reason };
}

function unitTerminalState(outcome: CatalogMergeCandidateBulkUnitResult): "completed" | "failed" | "skipped" {
  if (outcome.status === "failed") {
    return "failed";
  }
  return outcome.status === "skipped-not-eligible" ? "skipped" : "completed";
}

function progressStatus(outcome: CatalogMergeCandidateBulkUnitResult): BulkSourceObservationProgress["status"] {
  return outcome.status === "skipped-not-eligible" ? "skipped" : outcome.status;
}

function encodeCompletedJobCursor(input: Readonly<{ completedAt: string; jobId: string }>): string {
  return Buffer.from(JSON.stringify([input.completedAt, input.jobId]), "utf8").toString("base64url");
}

function decodeCompletedJobCursor(cursor: string): Readonly<{ completedAt: string; jobId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new CatalogMergeCandidateBulkJobCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed[0]) ||
    !parsed[1]
  ) {
    throw new CatalogMergeCandidateBulkJobCursorError();
  }
  return { completedAt: parsed[0], jobId: parsed[1] };
}
