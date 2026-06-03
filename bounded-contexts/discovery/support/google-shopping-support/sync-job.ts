import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  isDurableJobHandoffError,
  runDurableJobSideEffect,
  type DurableJobEvent,
  type DurableJobExecutionContext,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  toDurableJobPublicSnapshot,
} from "@chase-sets/platform-runtime/durable-job-store";
import type { GoogleShoppingPayloadInput } from "./export-row";

export type GoogleShoppingSyncMode = "dry-run" | "live";

export type GoogleShoppingSyncProviderOperation =
  | "insert-product-input"
  | "patch-product-input"
  | "delete-product-input"
  | "get-processed-product";

export type GoogleShoppingSyncProviderResult =
  | Readonly<{
      status: "success" | "dry-run";
      operation: GoogleShoppingSyncProviderOperation;
      attempts: number;
      request?: unknown;
      productInputName?: string | null;
      productName?: string | null;
    }>
  | Readonly<{
      status: "permanent-failure" | "transient-failure";
      operation: GoogleShoppingSyncProviderOperation;
      attempts: number;
      request?: unknown;
      error: Readonly<{
        code: string;
        message: string;
        httpStatus: number | null;
        retryable: boolean;
        providerRequestId: string | null;
        details?: unknown;
      }>;
    }>;

export type GoogleShoppingSyncMerchantClient = Readonly<{
  insertOrUpdateProductInput: (
    payload: GoogleShoppingPayloadInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
  deleteProductInput: (
    offerId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
}>;

export type GoogleShoppingFullSyncJobPayload = Readonly<{
  mode: GoogleShoppingSyncMode;
  batchSize: number;
  requestedByUserId: string | null;
  requestedForAccountId: string | null;
}>;

export type GoogleShoppingFullSyncJobProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentRowId: string | null;
  submitted: number;
  skipped: number;
  deleted: number;
  failed: number;
  excluded: number;
  message: string | null;
}>;

export type GoogleShoppingFullSyncJobResult = Readonly<{
  mode: GoogleShoppingSyncMode;
  submitted: number;
  skipped: number;
  deleted: number;
  failed: number;
  excluded: number;
  total: number;
}>;

export type GoogleShoppingFullSyncJob = DurableJobRecord<
  GoogleShoppingFullSyncJobPayload,
  GoogleShoppingFullSyncJobProgress,
  GoogleShoppingFullSyncJobResult
>;

export type GoogleShoppingFullSyncJobStatus = DurableJobPublicSnapshot<
  GoogleShoppingFullSyncJobProgress,
  GoogleShoppingFullSyncJobResult
>;

export type GoogleShoppingFeedRowForSync = Readonly<{
  rowId: string;
  merchantOfferId: string;
  payload: GoogleShoppingPayloadInput | null;
  payloadHash: string | null;
  eligibilityStatus: string;
  exclusionReasons: unknown;
  syncStatus: string;
  lastSubmittedPayloadHash: string | null;
  tombstoneStatus: string;
  deleteSubmittedAt: string | null;
}>;

type GoogleShoppingSyncRuntimeDeps = Readonly<{
  db: PgQueryable;
}>;

const FULL_SYNC_JOB_KIND = "full-sync";
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

export type GoogleShoppingSyncServices = Readonly<{
  enqueueFullSyncJob: (
    params: Readonly<{ mode: GoogleShoppingSyncMode; batchSize?: number }>,
    context: EventStoreContext,
  ) => Promise<GoogleShoppingFullSyncJob>;
  getFullSyncJob: (jobId: string) => Promise<GoogleShoppingFullSyncJob | null>;
  listFullSyncJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<
    readonly DurableJobEvent<
      GoogleShoppingFullSyncJobPayload,
      GoogleShoppingFullSyncJobProgress,
      GoogleShoppingFullSyncJobResult
    >[]
  >;
  waitForFullSyncJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  pruneFullSyncJobRetention: (input?: { completedBefore?: string | Date; limit?: number }) => Promise<number>;
  processNextFullSyncJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    merchantClientForMode: (mode: GoogleShoppingSyncMode) => GoogleShoppingSyncMerchantClient;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
}>;

export function createGoogleShoppingSyncRuntime(deps: GoogleShoppingSyncRuntimeDeps): GoogleShoppingSyncServices {
  const jobStore = createPostgresDurableJobStore<
    GoogleShoppingFullSyncJobPayload,
    GoogleShoppingFullSyncJobProgress,
    GoogleShoppingFullSyncJobResult
  >(deps.db, {
    jobsTable: "discovery_google_shopping_sync_jobs",
    eventsTable: "discovery_google_shopping_sync_job_events",
    notifyChannel: "discovery_google_shopping_sync_job_events",
  });

  return {
    enqueueFullSyncJob: async (params, context) => {
      const total = await countGoogleShoppingFeedRows(deps.db);
      return jobStore.enqueue({
        jobId: createJobId(),
        jobKind: FULL_SYNC_JOB_KIND,
        payload: {
          mode: params.mode,
          batchSize: normalizeBatchSize(params.batchSize),
          requestedByUserId: context.audit.performedByUserId,
          requestedForAccountId: context.audit.forAccountId,
        },
        progress: googleShoppingSyncProgress({
          phase: "queued",
          completed: 0,
          total,
          currentRowId: null,
          message: "Google Shopping full sync queued.",
        }),
        eventContext: context,
      });
    },
    getFullSyncJob: (jobId) => jobStore.get(jobId),
    listFullSyncJobEvents: (jobId, afterSequence = 0) => jobStore.listEvents(jobId, afterSequence),
    waitForFullSyncJobEvents: (jobId, signal) => jobStore.waitForEvents({ jobId, signal }),
    pruneFullSyncJobRetention: (input = {}) =>
      jobStore.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? retentionCutoff(7),
        limit: input.limit,
      }),
    processNextFullSyncJob: async (input) => {
      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: [FULL_SYNC_JOB_KIND],
      });
      if (!claimed) {
        return 0;
      }

      try {
        throwIfGoogleShoppingSyncCancelled(input);
        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Google Shopping full sync job was cancelled.",
          claimLostMessage: "Google Shopping full sync job claim was lost before the status update completed.",
        });
        const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
          minIntervalMs: 1_000,
          minCompletedDelta: Math.max(1, Math.floor(claimed.payload.batchSize / 2)),
          minRenewIntervalMs: 5_000,
          completed: (progress) => progress.completed,
          isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
        });
        const total = await countGoogleShoppingFeedRows(deps.db);
        let progress = googleShoppingSyncProgress({
          ...claimed.progress,
          phase: "processing",
          total,
          message: "Processing Google Shopping full sync.",
        });
        await requireGoogleShoppingSyncClaim(
          jobStore.updateProgress({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
            progress,
          }),
        );

        const merchantClient = input.merchantClientForMode(claimed.payload.mode);
        let cursor: string | null = null;

        for (;;) {
          throwIfGoogleShoppingSyncCancelled(input);
          const rows = await listGoogleShoppingFeedRowsAfter(deps.db, {
            afterRowId: cursor,
            limit: claimed.payload.batchSize,
          });
          if (rows.length === 0) {
            break;
          }

          for (const row of rows) {
            throwIfGoogleShoppingSyncCancelled(input);
            const outcome = await processGoogleShoppingSyncRow({
              db: deps.db,
              row,
              mode: claimed.payload.mode,
              merchantClient,
              signal: input.signal,
              jobContext,
            });
            progress = addGoogleShoppingSyncOutcome(progress, row.rowId, outcome);
            await progressCheckpoint.checkpoint(progress, toGoogleShoppingSyncResult(claimed.payload.mode, progress));
          }

          cursor = rows[rows.length - 1]?.rowId ?? cursor;
        }

        const finalProgress = googleShoppingSyncProgress({
          ...progress,
          phase: "completed",
          completed: progress.completed,
          total: Math.max(progress.total, progress.completed),
          message: "Google Shopping full sync completed.",
        });
        const result = toGoogleShoppingSyncResult(claimed.payload.mode, finalProgress);
        await requireGoogleShoppingSyncClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: finalProgress,
            result,
          }),
        );
        return 1;
      } catch (error) {
        if (isDurableJobHandoffError(error, input)) {
          return 0;
        }
        await requireGoogleShoppingSyncClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Google Shopping full sync job failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Google Shopping full sync job failed.",
          }),
        );
        return 1;
      }
    },
  };
}

export function toGoogleShoppingFullSyncJobStatus(job: GoogleShoppingFullSyncJob): GoogleShoppingFullSyncJobStatus {
  return toDurableJobPublicSnapshot(job);
}

export function classifyGoogleShoppingSyncRow(
  row: GoogleShoppingFeedRowForSync,
):
  | Readonly<{ action: "submit"; reason: "changed" | "resubmit-after-delete" }>
  | Readonly<{ action: "delete"; reason: "tombstone" | "no-longer-eligible" }>
  | Readonly<{ action: "skip"; reason: "unchanged" }>
  | Readonly<{ action: "exclude"; reason: "not-eligible" | "tombstone-never-submitted" }>
  | Readonly<{ action: "fail"; reason: "missing-payload" }> {
  const wasSubmitted = Boolean(row.lastSubmittedPayloadHash);
  const deleteAlreadySubmitted = Boolean(row.deleteSubmittedAt);
  const isTombstone = row.tombstoneStatus !== "live";
  const isEligible = row.eligibilityStatus === "eligible";

  if (isTombstone) {
    if (wasSubmitted && !deleteAlreadySubmitted) {
      return { action: "delete", reason: "tombstone" };
    }
    return { action: "exclude", reason: "tombstone-never-submitted" };
  }

  if (!isEligible) {
    if (wasSubmitted && !deleteAlreadySubmitted) {
      return { action: "delete", reason: "no-longer-eligible" };
    }
    return { action: "exclude", reason: "not-eligible" };
  }

  if (!row.payload || !row.payloadHash) {
    return { action: "fail", reason: "missing-payload" };
  }

  if (!deleteAlreadySubmitted && row.lastSubmittedPayloadHash && row.payloadHash === row.lastSubmittedPayloadHash) {
    return { action: "skip", reason: "unchanged" };
  }

  return { action: "submit", reason: deleteAlreadySubmitted ? "resubmit-after-delete" : "changed" };
}

export async function processGoogleShoppingSyncRow(input: {
  db: PgQueryable;
  row: GoogleShoppingFeedRowForSync;
  mode: GoogleShoppingSyncMode;
  merchantClient: GoogleShoppingSyncMerchantClient;
  signal?: AbortSignal;
  jobContext: DurableJobExecutionContext<GoogleShoppingFullSyncJobProgress, GoogleShoppingFullSyncJobResult>;
}): Promise<"submitted" | "skipped" | "deleted" | "failed" | "excluded"> {
  const classification = classifyGoogleShoppingSyncRow(input.row);
  const attemptedAt = new Date().toISOString();

  if (classification.action === "skip") {
    return "skipped";
  }
  if (classification.action === "exclude") {
    return "excluded";
  }
  if (classification.action === "fail") {
    if (input.mode === "live") {
      await recordGoogleShoppingRowFailure(input.db, input.row.rowId, {
        attemptedAt,
        operation: "insert-product-input",
        code: "google_shopping_missing_payload",
        message: "Eligible Google Shopping feed row is missing payload or payload hash.",
        response: { classification },
        providerRequestId: null,
      });
    }
    return "failed";
  }

  try {
    const result =
      classification.action === "submit"
        ? await runGoogleShoppingSyncSideEffect(input.jobContext, (signal) =>
            input.merchantClient.insertOrUpdateProductInput(input.row.payload!, { signal }),
          )
        : await runGoogleShoppingSyncSideEffect(input.jobContext, (signal) =>
            input.merchantClient.deleteProductInput(input.row.merchantOfferId, { signal }),
          );

    if (result.status === "success" || result.status === "dry-run") {
      if (input.mode === "live") {
        if (classification.action === "submit") {
          await recordGoogleShoppingRowSubmitted(input.db, input.row, { attemptedAt, result });
        } else {
          await recordGoogleShoppingRowDeleted(input.db, input.row.rowId, { attemptedAt, result });
        }
      }
      return classification.action === "submit" ? "submitted" : "deleted";
    }

    if (isGoogleShoppingSyncProviderFailure(result) && input.mode === "live") {
      await recordGoogleShoppingRowFailure(input.db, input.row.rowId, {
        attemptedAt,
        operation: result.operation,
        code: result.error.code,
        message: result.error.message,
        response: result,
        providerRequestId: result.error.providerRequestId,
      });
    }
    return "failed";
  } catch (error) {
    if (isDurableJobHandoffError(error, { signal: input.signal })) {
      throw error;
    }
    if (input.mode === "live") {
      await recordGoogleShoppingRowFailure(input.db, input.row.rowId, {
        attemptedAt,
        operation: classification.action === "submit" ? "insert-product-input" : "delete-product-input",
        code: "google_shopping_sync_exception",
        message: error instanceof Error ? error.message : "Google Shopping sync row failed.",
        response: { error: error instanceof Error ? error.message : String(error) },
        providerRequestId: null,
      });
    }
    return "failed";
  }
}

async function listGoogleShoppingFeedRowsAfter(
  db: PgQueryable,
  input: Readonly<{ afterRowId: string | null; limit: number }>,
): Promise<GoogleShoppingFeedRowForSync[]> {
  const result = await db.query<{
    row_id: string;
    merchant_offer_id: string;
    payload: unknown;
    payload_hash: string | null;
    eligibility_status: string;
    exclusion_reasons: unknown;
    sync_status: string;
    last_submitted_payload_hash: string | null;
    tombstone_status: string;
    delete_submitted_at: Date | string | null;
  }>(
    `SELECT row_id,
            merchant_offer_id,
            payload,
            payload_hash,
            eligibility_status,
            exclusion_reasons,
            sync_status,
            last_submitted_payload_hash,
            tombstone_status,
            delete_submitted_at
     FROM discovery_google_shopping_feed_rows
     WHERE ($1::text IS NULL OR row_id > $1)
     ORDER BY row_id ASC
     LIMIT $2`,
    [input.afterRowId, input.limit],
  );

  return result.rows.map((row) => ({
    rowId: row.row_id,
    merchantOfferId: row.merchant_offer_id,
    payload: readJsonValue<GoogleShoppingPayloadInput | null>(row.payload),
    payloadHash: row.payload_hash,
    eligibilityStatus: row.eligibility_status,
    exclusionReasons: row.exclusion_reasons,
    syncStatus: row.sync_status,
    lastSubmittedPayloadHash: row.last_submitted_payload_hash,
    tombstoneStatus: row.tombstone_status,
    deleteSubmittedAt: row.delete_submitted_at == null ? null : formatTimestamp(row.delete_submitted_at),
  }));
}

async function countGoogleShoppingFeedRows(db: PgQueryable): Promise<number> {
  const result = await db.query<{ total: number | string }>(
    `SELECT COUNT(*)::integer AS total FROM discovery_google_shopping_feed_rows`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function recordGoogleShoppingRowSubmitted(
  db: PgQueryable,
  row: GoogleShoppingFeedRowForSync,
  input: Readonly<{ attemptedAt: string; result: GoogleShoppingSyncProviderResult }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET sync_status = 'submitted',
         last_submitted_payload_hash = $2,
         last_submitted_at = $3::timestamptz,
         last_sync_attempted_at = $3::timestamptz,
         last_sync_error_code = NULL,
         last_sync_error_message = NULL,
         last_provider_request_id = NULL,
         last_provider_operation = $4,
         last_provider_response = $5::jsonb,
         delete_submitted_at = NULL,
         updated_at = now()
     WHERE row_id = $1`,
    [
      row.rowId,
      row.payloadHash,
      input.attemptedAt,
      input.result.operation,
      JSON.stringify(safeProviderResponse(input.result)),
    ],
  );
}

async function recordGoogleShoppingRowDeleted(
  db: PgQueryable,
  rowId: string,
  input: Readonly<{ attemptedAt: string; result: GoogleShoppingSyncProviderResult }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET sync_status = 'deleted',
         delete_submitted_at = $2::timestamptz,
         last_sync_attempted_at = $2::timestamptz,
         last_sync_error_code = NULL,
         last_sync_error_message = NULL,
         last_provider_request_id = NULL,
         last_provider_operation = $3,
         last_provider_response = $4::jsonb,
         updated_at = now()
     WHERE row_id = $1`,
    [rowId, input.attemptedAt, input.result.operation, JSON.stringify(safeProviderResponse(input.result))],
  );
}

async function recordGoogleShoppingRowFailure(
  db: PgQueryable,
  rowId: string,
  input: Readonly<{
    attemptedAt: string;
    operation: GoogleShoppingSyncProviderOperation;
    code: string;
    message: string;
    providerRequestId: string | null;
    response: unknown;
  }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET sync_status = 'failed',
         last_sync_attempted_at = $2::timestamptz,
         last_sync_error_code = $3,
         last_sync_error_message = $4,
         last_provider_request_id = $5,
         last_provider_operation = $6,
         last_provider_response = $7::jsonb,
         updated_at = now()
     WHERE row_id = $1`,
    [
      rowId,
      input.attemptedAt,
      input.code.slice(0, 200),
      input.message.slice(0, 1_000),
      input.providerRequestId,
      input.operation,
      JSON.stringify(safeProviderResponse(input.response)),
    ],
  );
}

async function runGoogleShoppingSyncSideEffect<T>(
  jobContext: DurableJobExecutionContext<GoogleShoppingFullSyncJobProgress, GoogleShoppingFullSyncJobResult>,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runDurableJobSideEffect(jobContext, work, {
    renewIntervalMs: 5_000,
    claimLostMessage: "Google Shopping full sync job claim was lost while calling Merchant API.",
  });
}

function googleShoppingSyncProgress(
  input: Readonly<Partial<GoogleShoppingFullSyncJobProgress>> &
    Pick<GoogleShoppingFullSyncJobProgress, "phase" | "completed" | "total" | "currentRowId" | "message">,
): GoogleShoppingFullSyncJobProgress {
  return {
    phase: input.phase,
    completed: input.completed,
    total: input.total,
    currentRowId: input.currentRowId,
    submitted: input.submitted ?? 0,
    skipped: input.skipped ?? 0,
    deleted: input.deleted ?? 0,
    failed: input.failed ?? 0,
    excluded: input.excluded ?? 0,
    message: input.message,
  };
}

function addGoogleShoppingSyncOutcome(
  progress: GoogleShoppingFullSyncJobProgress,
  rowId: string,
  outcome: "submitted" | "skipped" | "deleted" | "failed" | "excluded",
): GoogleShoppingFullSyncJobProgress {
  return {
    ...progress,
    completed: progress.completed + 1,
    currentRowId: rowId,
    submitted: progress.submitted + (outcome === "submitted" ? 1 : 0),
    skipped: progress.skipped + (outcome === "skipped" ? 1 : 0),
    deleted: progress.deleted + (outcome === "deleted" ? 1 : 0),
    failed: progress.failed + (outcome === "failed" ? 1 : 0),
    excluded: progress.excluded + (outcome === "excluded" ? 1 : 0),
    message: "Processed Google Shopping feed row.",
  };
}

function toGoogleShoppingSyncResult(
  mode: GoogleShoppingSyncMode,
  progress: GoogleShoppingFullSyncJobProgress,
): GoogleShoppingFullSyncJobResult {
  return {
    mode,
    submitted: progress.submitted,
    skipped: progress.skipped,
    deleted: progress.deleted,
    failed: progress.failed,
    excluded: progress.excluded,
    total: progress.total,
  };
}

function normalizeBatchSize(value: number | undefined) {
  const parsed = Math.floor(value ?? DEFAULT_BATCH_SIZE);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.max(1, Math.min(parsed, MAX_BATCH_SIZE));
}

function createJobId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return `job_${cryptoLike?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function retentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

async function requireGoogleShoppingSyncClaim(succeeded: Promise<boolean> | boolean) {
  if (!(await succeeded)) {
    throw new Error("Google Shopping full sync job claim was lost before the status update completed.");
  }
}

function throwIfGoogleShoppingSyncCancelled(input?: { signal?: AbortSignal; throwIfLeaseLost?: () => void }) {
  input?.throwIfLeaseLost?.();
  if (input?.signal?.aborted) {
    throw new Error("Google Shopping full sync job was cancelled.");
  }
}

function safeProviderResponse(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(safeProviderResponse);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      key.toLowerCase() === "body" ? "[omitted]" : safeProviderResponse(entry),
    ]),
  );
}

function isGoogleShoppingSyncProviderFailure(
  result: GoogleShoppingSyncProviderResult,
): result is Extract<GoogleShoppingSyncProviderResult, { status: "permanent-failure" | "transient-failure" }> {
  return result.status === "permanent-failure" || result.status === "transient-failure";
}
