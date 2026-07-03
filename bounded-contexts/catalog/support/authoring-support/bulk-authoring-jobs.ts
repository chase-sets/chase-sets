import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  type DurableJobEvent,
  type DurableJobExecutionContext,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  isDurableJobWorkUnitTerminalAccepted,
  type DurableJobWorkUnitTerminalOutcome,
  type DurableJobWorkUnitRecord,
  type DurableJobWorkUnitSummary,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import { createId } from "@chase-sets/primitives/typed-ids";
import { z } from "zod";
import type {
  BulkLifecycleExecutionOptions,
  BulkLifecycleExecutionProgress,
  BulkSelection,
} from "../runtime-support/bulk-lifecycle";
import type { BulkEditCatalogItemOperation } from "../../features/catalog-items/api/runtime";
import type { CatalogServices } from "./services";

export type CatalogAuthoringBulkJobKind =
  | "catalog.authoring.dimensions.lifecycle"
  | "catalog.authoring.fields.lifecycle"
  | "catalog.authoring.components.lifecycle"
  | "catalog.authoring.blueprints.lifecycle"
  | "catalog.authoring.categories.lifecycle"
  | "catalog.authoring.reference-types.lifecycle"
  | "catalog.authoring.reference-records.lifecycle"
  | "catalog.authoring.items.lifecycle"
  | "catalog.authoring.items.publish"
  | "catalog.authoring.items.edit";

export type CatalogAuthoringBulkJobPayload = Readonly<{
  kind: CatalogAuthoringBulkJobKind;
  action: string;
  selection?: BulkSelection<unknown>;
  itemIds?: readonly string[];
  operation?: unknown;
}>;

export type CatalogAuthoringBulkJobProgress = Readonly<{
  phase: "queued" | "running" | "completed" | "failed";
  completed: number;
  total: number;
  currentName: string | null;
  status: string | null;
}>;

export type CatalogAuthoringBulkJobResult = unknown;

type CatalogAuthoringBulkWorkUnitPayload = Readonly<{
  itemId: string;
}>;

type CatalogAuthoringBulkWorkUnitResult = Readonly<{
  itemId: string;
  result: unknown;
}>;

type CatalogAuthoringBulkWorkUnitStore = ReturnType<
  typeof createPostgresDurableJobWorkUnitStore<
    CatalogAuthoringBulkJobPayload,
    CatalogAuthoringBulkJobProgress,
    CatalogAuthoringBulkJobResult,
    CatalogAuthoringBulkWorkUnitPayload,
    CatalogAuthoringBulkWorkUnitResult,
    CatalogAuthoringBulkJob
  >
>;

export type CatalogAuthoringBulkJob = Readonly<{
  jobId: string;
  kind: CatalogAuthoringBulkJobKind;
  action: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: CatalogAuthoringBulkJobProgress;
  result: CatalogAuthoringBulkJobResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type CatalogAuthoringBulkJobEvent = DurableJobEvent<
  CatalogAuthoringBulkJobPayload,
  CatalogAuthoringBulkJobProgress,
  CatalogAuthoringBulkJobResult,
  CatalogAuthoringBulkJob
>;

export type CatalogAuthoringBulkJobServices = Readonly<{
  enqueue: (input: {
    kind: CatalogAuthoringBulkJobKind;
    action: string;
    selection?: BulkSelection<unknown>;
    itemIds?: readonly string[];
    operation?: unknown;
    context: EventStoreContext;
  }) => Promise<CatalogAuthoringBulkJob>;
  get: (jobId: string, context?: EventStoreContext | null) => Promise<CatalogAuthoringBulkJob | null>;
  listActive: (context?: EventStoreContext | null) => Promise<readonly CatalogAuthoringBulkJob[]>;
  listEvents: (
    jobId: string,
    afterSequence?: number,
    context?: EventStoreContext | null,
  ) => Promise<readonly CatalogAuthoringBulkJobEvent[]>;
  waitForEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  pruneRetention: (input?: { completedBefore?: string | Date; limit?: number }) => Promise<number>;
  processNext: (input: {
    claimOwnerId: string;
    claimTtlMs?: number;
    services: CatalogServices;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<boolean>;
  getWorkUnitSummary: (input?: { jobId?: string | null }) => Promise<DurableJobWorkUnitSummary>;
}>;

const storeTables = {
  jobsTable: "catalog_authoring_bulk_jobs",
  eventsTable: "catalog_authoring_bulk_job_events",
} as const;

export function createCatalogAuthoringBulkJobServices(db: PgQueryable): CatalogAuthoringBulkJobServices {
  const store = createPostgresDurableJobStore<
    CatalogAuthoringBulkJobPayload,
    CatalogAuthoringBulkJobProgress,
    CatalogAuthoringBulkJobResult,
    CatalogAuthoringBulkJob
  >(db, storeTables, { eventSnapshot: toCatalogAuthoringBulkJob });
  const workUnitStore = createPostgresDurableJobWorkUnitStore<
    CatalogAuthoringBulkJobPayload,
    CatalogAuthoringBulkJobProgress,
    CatalogAuthoringBulkJobResult,
    CatalogAuthoringBulkWorkUnitPayload,
    CatalogAuthoringBulkWorkUnitResult,
    CatalogAuthoringBulkJob
  >(
    db,
    {
      ...storeTables,
      workUnitsTable: "catalog_authoring_bulk_work_units",
    },
    {
      workflowName: "catalog.authoring-bulk",
      eventSnapshot: toCatalogAuthoringBulkJob,
    },
  );

  return {
    enqueue: async (input) => {
      const publishItemIds = input.kind === "catalog.authoring.items.publish" ? uniqueStrings(input.itemIds ?? []) : [];
      if (input.kind === "catalog.authoring.items.publish" && publishItemIds.length === 0) {
        throw new Error("Catalog authoring item publish job requires at least one Catalog Item.");
      }
      const payload: CatalogAuthoringBulkJobPayload = {
        kind: input.kind,
        action: input.action,
        selection: input.selection,
        itemIds: input.kind === "catalog.authoring.items.publish" ? publishItemIds : input.itemIds,
        operation: input.operation,
      };
      const job = await store.enqueue({
        jobId: createId("job"),
        jobKind: input.kind,
        payload,
        progress: progress("queued", 0, input.kind === "catalog.authoring.items.publish" ? publishItemIds.length : 1),
        eventContext: input.context,
      });
      if (input.kind === "catalog.authoring.items.publish") {
        await workUnitStore.enqueue({
          jobId: job.jobId,
          units: publishItemIds.map((itemId) => ({
            unitId: itemId,
            unitKind: input.kind,
            payload: { itemId },
          })),
        });
      }

      return toCatalogAuthoringBulkJob(job);
    },
    get: async (jobId, context) => {
      const job = await store.get(jobId);
      if (!job || !catalogAuthoringJobMatchesContext(job, context)) {
        return null;
      }
      return job ? toCatalogAuthoringBulkJob(job) : null;
    },
    listActive: async (context) =>
      (await store.listActive())
        .filter((job) => catalogAuthoringJobMatchesContext(job, context))
        .map(toCatalogAuthoringBulkJob),
    listEvents: async (jobId, afterSequence, context) => {
      const job = await store.get(jobId);
      if (!job || !catalogAuthoringJobMatchesContext(job, context)) {
        return [];
      }
      return store.listEvents(jobId, afterSequence);
    },
    waitForEvents: (jobId, signal) => store.waitForEvents({ jobId, signal }),
    pruneRetention: (input = {}) =>
      store.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? catalogAuthoringRetentionCutoff(7),
        limit: input.limit,
      }),
    processNext: async (input) => {
      const claimTtlMs = input.claimTtlMs ?? 60_000;
      const processedUnit = await processNextCatalogAuthoringWorkUnit({
        ...input,
        claimTtlMs,
        workUnitStore,
      });
      if (processedUnit) {
        return true;
      }

      const job = await store.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs,
        jobKinds: CATALOG_AUTHORING_PARENT_CLAIM_KINDS,
      });

      if (!job) {
        return false;
      }

      const context = job.eventContext;
      if (!context) {
        await requireCatalogAuthoringBulkJobClaim(
          store.fail({
            jobId: job.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: progress("failed"),
            errorMessage: "Catalog authoring bulk job is missing event context.",
          }),
        );
        return true;
      }

      try {
        throwIfCatalogAuthoringBulkJobCancelled(input);
        await requireCatalogAuthoringBulkJobClaim(
          store.updateProgress({
            jobId: job.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs,
            progress: progress("running"),
          }),
        );
        const jobContext = createDurableJobExecutionContext(store, {
          jobId: job.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Catalog authoring bulk job was cancelled.",
          claimLostMessage: "Catalog authoring bulk job claim was lost before the status update completed.",
        });
        const result = await executeCatalogAuthoringBulkJob(input.services, job.payload, context, jobContext);
        jobContext.throwIfCancelled();
        await requireCatalogAuthoringBulkJobClaim(
          store.complete({
            jobId: job.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: progress("completed"),
            result,
          }),
        );
      } catch (error) {
        if (isCatalogAuthoringBulkJobHandoff(error, input)) {
          return false;
        }
        await requireCatalogAuthoringBulkJobClaim(
          store.fail({
            jobId: job.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: progress("failed"),
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        );
      }

      return true;
    },
    getWorkUnitSummary: (input = {}) => workUnitStore.summarize(input),
  };
}

const CATALOG_AUTHORING_PARENT_CLAIM_KINDS: readonly CatalogAuthoringBulkJobKind[] = [
  "catalog.authoring.dimensions.lifecycle",
  "catalog.authoring.fields.lifecycle",
  "catalog.authoring.components.lifecycle",
  "catalog.authoring.blueprints.lifecycle",
  "catalog.authoring.categories.lifecycle",
  "catalog.authoring.reference-types.lifecycle",
  "catalog.authoring.reference-records.lifecycle",
  "catalog.authoring.items.lifecycle",
  "catalog.authoring.items.edit",
];

const editOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assignBlueprint"), blueprintId: z.string() }),
  z.object({ action: z.literal("assignCategory"), categoryId: z.string() }),
  z.object({ action: z.literal("removeCategory"), categoryId: z.string() }),
  z.object({ action: z.literal("setTags"), tags: z.array(z.string()) }),
  z.object({ action: z.literal("mergeTags"), tags: z.array(z.string()) }),
  z.object({ action: z.literal("clearTags") }),
]);

export function parseEditOperation(value: unknown): BulkEditCatalogItemOperation {
  const parsed = editOperationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Catalog Item bulk edit operation is invalid.");
  }

  return parsed.data;
}

async function processNextCatalogAuthoringWorkUnit(input: {
  claimOwnerId: string;
  claimTtlMs: number;
  services: CatalogServices;
  workflowMaxActiveClaims?: number;
  jobMaxActiveClaims?: number;
  laneName?: string | null;
  signal?: AbortSignal;
  throwIfLeaseLost?: () => void;
  workUnitStore: CatalogAuthoringBulkWorkUnitStore;
}): Promise<boolean> {
  const claimResult = await input.workUnitStore.claimNext({
    claimOwnerId: input.claimOwnerId,
    claimTtlMs: input.claimTtlMs,
    workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
    jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
    jobKinds: ["catalog.authoring.items.publish"],
    laneName: input.laneName ?? null,
  });
  const claim = claimResult.claim;
  if (!claim) {
    return false;
  }

  try {
    throwIfCatalogAuthoringBulkJobCancelled(input);
    const context = claim.job.eventContext;
    if (!context) {
      throw new Error("Catalog authoring bulk job is missing event context.");
    }
    const itemResult = await input.services.items.publishBulk([claim.unit.payload.itemId], context, {
      throwIfCancelled: () => throwIfCatalogAuthoringBulkJobCancelled(input),
    });
    await requireCatalogAuthoringBulkJobClaim(
      input.workUnitStore.recordTerminal({
        jobId: claim.job.jobId,
        unitId: claim.unit.unitId,
        claimOwnerId: claim.claimOwnerId,
        claimToken: claim.claimToken,
        state: itemResult.failed_count > 0 ? "failed" : itemResult.skipped_count > 0 ? "skipped" : "completed",
        unitResult: { itemId: claim.unit.payload.itemId, result: itemResult },
        errorMessage: itemResult.failed_count > 0 ? "Catalog Item publish failed." : null,
        parentProgress: claim.job.progress,
        parentResult: claim.job.result,
        resolveParentUpdate: (queryable) => catalogAuthoringParentUpdateFromWorkUnits(queryable, claim.job),
      }),
    );
    return true;
  } catch (error) {
    if (isCatalogAuthoringBulkJobHandoff(error, input)) {
      await input.workUnitStore.releaseClaim({
        jobId: claim.job.jobId,
        unitId: claim.unit.unitId,
        claimOwnerId: claim.claimOwnerId,
        claimToken: claim.claimToken,
      });
      return false;
    }
    await requireCatalogAuthoringBulkJobClaim(
      input.workUnitStore.recordTerminal({
        jobId: claim.job.jobId,
        unitId: claim.unit.unitId,
        claimOwnerId: claim.claimOwnerId,
        claimToken: claim.claimToken,
        state: "failed",
        unitResult: {
          itemId: claim.unit.payload.itemId,
          result: { error: error instanceof Error ? error.message : String(error) },
        },
        errorMessage: error instanceof Error ? error.message : "Catalog authoring bulk work unit failed.",
        parentProgress: claim.job.progress,
        parentResult: claim.job.result,
        resolveParentUpdate: (queryable) => catalogAuthoringParentUpdateFromWorkUnits(queryable, claim.job),
      }),
    );
    return true;
  }
}

async function catalogAuthoringParentUpdateFromWorkUnits(
  queryable: PgQueryable,
  job: Readonly<{
    jobId: string;
    progress: CatalogAuthoringBulkJobProgress;
    payload: CatalogAuthoringBulkJobPayload;
  }>,
): Promise<
  Readonly<{
    parentProgress: CatalogAuthoringBulkJobProgress;
    parentResult: CatalogAuthoringBulkJobResult;
    completeJob: boolean;
  }>
> {
  const units = await listCatalogAuthoringWorkUnitsForJob(queryable, job.jobId);
  const terminalUnits = units.filter(
    (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
  );
  const total = Math.max(job.progress.total, units.length);
  const completeJob = total > 0 && terminalUnits.length >= total;
  const unitResults = terminalUnits.flatMap((unit) => (unit.result ? [unit.result] : []));
  const itemResults = unitResults.flatMap((unitResult) => readCatalogAuthoringPublishCandidates(unitResult.result));
  const parentResult = {
    item_ids: uniqueStrings(job.payload.itemIds ?? units.map((unit) => unit.unitId)),
    total: itemResults.length,
    published_count: itemResults.filter((candidate) => candidate.outcome === "published").length,
    failed_count: itemResults.filter((candidate) => candidate.outcome === "failed").length,
    skipped_count: itemResults.filter((candidate) => candidate.outcome === "skipped").length,
    candidates: itemResults,
  };

  return {
    parentProgress: progress(completeJob ? "completed" : "running", terminalUnits.length, total),
    parentResult,
    completeJob,
  };
}

async function listCatalogAuthoringWorkUnitsForJob(
  queryable: PgQueryable,
  jobId: string,
): Promise<
  readonly DurableJobWorkUnitRecord<CatalogAuthoringBulkWorkUnitPayload, CatalogAuthoringBulkWorkUnitResult>[]
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
     FROM catalog_authoring_bulk_work_units
     WHERE job_id = $1
     ORDER BY created_at ASC, unit_id ASC`,
    [jobId],
  );

  return result.rows.map((row) => ({
    jobId,
    unitId: row.unit_id,
    unitKind: row.unit_kind,
    state: row.state,
    payload: readJsonValue(row.payload),
    result: row.result == null ? null : readJsonValue(row.result),
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

export function toCatalogAuthoringBulkJob(
  job: Readonly<{
    jobId: string;
    jobKind: string;
    status: CatalogAuthoringBulkJob["status"];
    payload: CatalogAuthoringBulkJobPayload;
    progress: CatalogAuthoringBulkJobProgress;
    result: CatalogAuthoringBulkJobResult | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
  }>,
): CatalogAuthoringBulkJob {
  return {
    jobId: job.jobId,
    kind: job.payload.kind,
    action: job.payload.action,
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

function catalogAuthoringJobMatchesContext(
  job: Readonly<{ eventContext: EventStoreContext | null }>,
  context?: EventStoreContext | null,
) {
  if (!context) {
    return true;
  }

  return (
    job.eventContext?.tenantId === context.tenantId &&
    job.eventContext?.audit?.forAccountId === context.audit?.forAccountId &&
    job.eventContext?.audit?.performedByUserId === context.audit?.performedByUserId
  );
}

async function executeCatalogAuthoringBulkJob(
  services: CatalogServices,
  payload: CatalogAuthoringBulkJobPayload,
  context: EventStoreContext,
  jobContext: DurableJobExecutionContext<CatalogAuthoringBulkJobProgress, CatalogAuthoringBulkJobResult>,
) {
  const progressOptions = catalogAuthoringProgressOptions(jobContext);
  switch (payload.kind) {
    case "catalog.authoring.dimensions.lifecycle":
      return services.dimensions.bulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
        progressOptions,
      );
    case "catalog.authoring.fields.lifecycle":
      return services.fields.bulkLifecycle.execute(requireSelection(payload), payload.action, context, progressOptions);
    case "catalog.authoring.components.lifecycle":
      return services.components.bulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
        progressOptions,
      );
    case "catalog.authoring.blueprints.lifecycle":
      return services.blueprints.bulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
        progressOptions,
      );
    case "catalog.authoring.categories.lifecycle":
      return services.categories.bulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
        progressOptions,
      );
    case "catalog.authoring.reference-types.lifecycle":
      return services.referenceData.referenceTypeBulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
        progressOptions,
      );
    case "catalog.authoring.reference-records.lifecycle":
      return services.referenceData.referenceRecordBulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
        progressOptions,
      );
    case "catalog.authoring.items.lifecycle":
      return services.items.bulkLifecycle.execute(requireSelection(payload), payload.action, context, progressOptions);
    case "catalog.authoring.items.publish":
      return services.items.publishBulk(payload.itemIds ?? [], context, progressOptions);
    case "catalog.authoring.items.edit":
      return services.items.editBulk(
        requireSelection(payload),
        parseEditOperation(payload.operation),
        context,
        progressOptions,
      );
    default:
      throw new Error(`Unsupported Catalog authoring bulk job kind: ${payload.kind}`);
  }
}

function requireSelection(payload: CatalogAuthoringBulkJobPayload): BulkSelection<never> {
  if (!payload.selection) {
    throw new Error("Catalog authoring bulk job requires a selection.");
  }

  return payload.selection as BulkSelection<never>;
}

function progress(
  phase: CatalogAuthoringBulkJobProgress["phase"],
  completed = phase === "completed" ? 1 : 0,
  total = 1,
): CatalogAuthoringBulkJobProgress {
  return {
    phase,
    completed,
    total,
    currentName: null,
    status: phase,
  };
}

function catalogAuthoringProgressOptions(
  jobContext: DurableJobExecutionContext<CatalogAuthoringBulkJobProgress, CatalogAuthoringBulkJobResult>,
): BulkLifecycleExecutionOptions {
  const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
    minIntervalMs: 1_000,
    minCompletedDelta: 10,
    minRenewIntervalMs: 5_000,
    completed: (progress) => progress.completed,
    isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
  });
  return {
    throwIfCancelled: jobContext.throwIfCancelled,
    onProgress: (progressUpdate) => progressCheckpoint.checkpoint(toCatalogAuthoringProgress(progressUpdate)),
  };
}

function toCatalogAuthoringProgress(progressUpdate: BulkLifecycleExecutionProgress): CatalogAuthoringBulkJobProgress {
  return {
    phase: "running",
    completed: progressUpdate.completed,
    total: progressUpdate.total,
    currentName: progressUpdate.currentName,
    status: progressUpdate.status,
  };
}

function catalogAuthoringRetentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

async function requireCatalogAuthoringBulkJobClaim(
  succeeded: Promise<boolean | DurableJobWorkUnitTerminalOutcome> | boolean | DurableJobWorkUnitTerminalOutcome,
) {
  const outcome = await succeeded;
  if (!isDurableJobWorkUnitTerminalAccepted(outcome)) {
    throw new Error("Catalog authoring bulk job claim was lost before the status update completed.");
  }
}

function throwIfCatalogAuthoringBulkJobCancelled(input: { signal?: AbortSignal; throwIfLeaseLost?: () => void }) {
  input.throwIfLeaseLost?.();
  if (input.signal?.aborted) {
    throw new Error("Catalog authoring bulk job was cancelled.");
  }
}

function isCatalogAuthoringBulkJobHandoff(error: unknown, input?: { signal?: AbortSignal }) {
  return (
    input?.signal?.aborted ||
    (error instanceof Error && (error.message.startsWith("Lost lease ") || error.message.includes("claim was lost")))
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function formatDateLike(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function readCatalogAuthoringPublishCandidates(value: unknown): ReadonlyArray<{ outcome?: string }> {
  if (!value || typeof value !== "object" || !("candidates" in value)) {
    return [];
  }
  const candidates = (value as { candidates?: unknown }).candidates;
  return Array.isArray(candidates) ? (candidates as ReadonlyArray<{ outcome?: string }>) : [];
}
