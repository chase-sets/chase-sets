import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { isDurableJobHandoffError, type DurableJobRecord } from "@chase-sets/platform-runtime/durable-job-store";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogMergeCandidateState, CatalogMergeCandidateStatus } from "../domain/catalog-merge-candidate";
import { listCatalogMergeCandidateIdsForScope } from "../read-model/queries";
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
  type BulkSourceObservationProgress,
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

const jobKinds: readonly CatalogMergeCandidateBulkJobKind[] = catalogMergeCandidateBulkJobKinds;

// A job enumerates every non-terminal candidate in the scope as a work unit,
// and each unit decides whether its candidate matches the job when it runs.
// Promote takes only `ready` candidates (no blocking conflicts); defer-remainder
// takes the candidates that still need a disposition. Every other candidate is
// left untouched and counted as skipped-not-eligible.
const enumeratedStatuses: readonly CatalogMergeCandidateStatus[] = ["ready", "has-conflicts", "stale", "deferred"];

const eligibleStatuses: Readonly<Record<CatalogMergeCandidateBulkJobKind, readonly CatalogMergeCandidateStatus[]>> = {
  "merge-candidate-promote": ["ready"],
  "merge-candidate-defer": ["has-conflicts", "stale"],
};

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
  return typeof value === "string" && (jobKinds as readonly string[]).includes(value);
}

export type SourceObservationMergeCandidateBulkJobRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  jobStore: CatalogMergeCandidateBulkJobStore;
  workUnitStore: CatalogMergeCandidateBulkWorkUnitStore;
  mergeCandidates: Pick<
    SourceObservationMergeCandidateRuntime,
    "loadCatalogMergeCandidateForReview" | "applyCatalogMergeCandidateReviewAtVersion"
  >;
}>;

/**
 * Scope-wide Catalog Merge Candidate review jobs on the bulk review runner. A
 * job enumerates one work unit per non-terminal scope candidate at start; each
 * unit re-checks its candidate's aggregate state and applies the review command
 * at the checked version, so retries and resumes collapse to one terminal outcome
 * per candidate and never promote twice.
 */
export function createSourceObservationMergeCandidateBulkJobRuntime({
  deps,
  jobStore,
  workUnitStore,
  mergeCandidates,
}: SourceObservationMergeCandidateBulkJobRuntimeDeps) {
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
      statuses: enumeratedStatuses,
    });
    const jobId = createId("job");
    await retainProviderSendJobBinding(deps, jobId);
    const job = await jobStore.enqueue({
      jobId,
      jobKind: input.kind,
      payload: { scopeRecordId, reason },
      progress: bulkProgress(0, candidateIds.length, null, null, "queued"),
      eventContext: input.context,
    });
    await workUnitStore.enqueue({
      jobId,
      units: candidateIds.map((candidateId) => ({
        unitId: candidateId,
        unitKind: input.kind,
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
      jobKinds,
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
        runSideEffect(() => reviewCandidate(job, candidateId, context)),
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

      const outcome: CatalogMergeCandidateBulkUnitResult = {
        candidateId,
        status: "failed",
        catalogItemId: null,
        reason: error instanceof Error ? error.message : "Catalog Merge Candidate bulk review failed.",
      };
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

  // One candidate, re-checked against its aggregate when the unit runs. A unit
  // resumed after its command was appended (but before its terminal was
  // recorded) recognizes its own job's review by the reason marker and reports
  // the same outcome instead of acting again.
  async function reviewCandidate(
    job: CatalogMergeCandidateBulkJob,
    candidateId: string,
    context: EventStoreContext,
  ): Promise<CatalogMergeCandidateBulkUnitResult> {
    const marker = bulkJobReasonMarker(job.jobId);
    const { state, version } = await mergeCandidates.loadCatalogMergeCandidateForReview(candidateId);
    if (state.id === null || state.snapshot === null) {
      return skippedNotEligible(candidateId, "Catalog Merge Candidate was not found.");
    }

    const appliedStatus = job.kind === "merge-candidate-promote" ? "promoted" : "deferred";
    if (state.status === appliedStatus && state.statusReason?.endsWith(marker)) {
      return appliedOutcome(job.kind, candidateId, state);
    }
    if (!eligibleStatuses[job.kind].includes(state.status)) {
      return skippedNotEligible(candidateId, `Catalog Merge Candidate is ${state.status}.`);
    }

    const decidedAt = new Date().toISOString();
    const reason = `${job.reason} ${marker}`;
    const actor = catalogMergeCandidateReviewActor(context);
    const next = await mergeCandidates.applyCatalogMergeCandidateReviewAtVersion({
      candidateId,
      command:
        job.kind === "merge-candidate-promote"
          ? { type: "PromoteCatalogMergeCandidate", reason, actor, promotedAt: decidedAt }
          : { type: "DeferCatalogMergeCandidate", reason, actor, deferredAt: decidedAt },
      expectedVersion: version,
      context,
    });
    return appliedOutcome(job.kind, candidateId, next);
  }

  async function reconcileTerminalCatalogMergeCandidateBulkJobs(): Promise<number> {
    // Reconcile runs inside the shared bulk review worker loop, so a row of any
    // other kind is skipped rather than allowed to fail the loop.
    const activeJobs = (await jobStore.listActive({ jobKinds })).filter((job) =>
      isCatalogMergeCandidateBulkJobKind(job.jobKind),
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
    if (!job || !isCatalogMergeCandidateBulkJobKind(job.jobKind) || (context && !jobMatchesContext(job, context))) {
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
        input.kind ? [input.kind] : [...jobKinds],
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
        input.kind ? [input.kind] : [...jobKinds],
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
  return {
    jobId: job.jobId,
    kind: requireCatalogMergeCandidateBulkJobKind(job.jobKind),
    scopeRecordId: job.payload.scopeRecordId,
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
  return {
    jobId: row.job_id,
    kind: requireCatalogMergeCandidateBulkJobKind(row.job_kind),
    scopeRecordId: payload.scopeRecordId,
    reason: payload.reason,
    status: row.status,
    progress: parseJsonField<BulkSourceObservationProgress>(row.progress, "progress"),
    result: row.result == null ? null : parseJsonField<CatalogMergeCandidateBulkJobResult>(row.result, "result"),
    errorMessage: row.error_message,
    createdAt: formatDateLike(row.created_at),
    startedAt: row.started_at == null ? null : formatDateLike(row.started_at),
    completedAt: row.completed_at == null ? null : formatDateLike(row.completed_at),
    updatedAt: formatDateLike(row.updated_at),
  };
}

function requireCatalogMergeCandidateBulkJobKind(value: string): CatalogMergeCandidateBulkJobKind {
  if (!isCatalogMergeCandidateBulkJobKind(value)) {
    throw new Error(`Bulk review job kind '${value}' is not a Catalog Merge Candidate bulk job.`);
  }
  return value;
}

export function bulkJobReasonMarker(jobId: string): string {
  return `(bulk job ${jobId})`;
}

function appliedOutcome(
  kind: CatalogMergeCandidateBulkJobKind,
  candidateId: string,
  state: CatalogMergeCandidateState,
): CatalogMergeCandidateBulkUnitResult {
  return kind === "merge-candidate-promote"
    ? {
        candidateId,
        status: "promoted",
        catalogItemId: state.snapshot?.matches.catalogItemId ?? null,
        reason: null,
      }
    : { candidateId, status: "deferred", catalogItemId: null, reason: null };
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
