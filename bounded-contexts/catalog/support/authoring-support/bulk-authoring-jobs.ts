import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createDurableJobExecutionContext,
  createPostgresDurableJobStore,
  type DurableJobEvent,
  type DurableJobExecutionContext,
} from "@chase-sets/platform-runtime/durable-job-store";
import { createId } from "@chase-sets/primitives/typed-ids";
import type {
  BulkLifecycleExecutionOptions,
  BulkLifecycleExecutionProgress,
  BulkSelection,
} from "../runtime-support/bulk-lifecycle";
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
  CatalogAuthoringBulkJobResult
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
  get: (jobId: string) => Promise<CatalogAuthoringBulkJob | null>;
  listActive: () => Promise<readonly CatalogAuthoringBulkJob[]>;
  listEvents: (jobId: string, afterSequence?: number) => Promise<readonly CatalogAuthoringBulkJobEvent[]>;
  waitForEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  pruneRetention: (input?: { completedBefore?: string | Date; limit?: number }) => Promise<number>;
  processNext: (input: {
    claimOwnerId: string;
    claimTtlMs?: number;
    services: CatalogServices;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<boolean>;
}>;

const storeTables = {
  jobsTable: "catalog_authoring_bulk_jobs",
  eventsTable: "catalog_authoring_bulk_job_events",
} as const;

export function createCatalogAuthoringBulkJobServices(db: PgQueryable): CatalogAuthoringBulkJobServices {
  const store = createPostgresDurableJobStore<
    CatalogAuthoringBulkJobPayload,
    CatalogAuthoringBulkJobProgress,
    CatalogAuthoringBulkJobResult
  >(db, storeTables);

  return {
    enqueue: async (input) => {
      const payload: CatalogAuthoringBulkJobPayload = {
        kind: input.kind,
        action: input.action,
        selection: input.selection,
        itemIds: input.itemIds,
        operation: input.operation,
      };
      const job = await store.enqueue({
        jobId: createId("job"),
        jobKind: input.kind,
        payload,
        progress: progress("queued"),
        eventContext: input.context,
      });

      return toCatalogAuthoringBulkJob(job);
    },
    get: async (jobId) => {
      const job = await store.get(jobId);
      return job ? toCatalogAuthoringBulkJob(job) : null;
    },
    listActive: async () => (await store.listActive()).map(toCatalogAuthoringBulkJob),
    listEvents: (jobId, afterSequence) => store.listEvents(jobId, afterSequence),
    waitForEvents: (jobId, signal) => store.waitForEvents({ jobId, signal }),
    pruneRetention: (input = {}) =>
      store.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? catalogAuthoringRetentionCutoff(7),
        limit: input.limit,
      }),
    processNext: async (input) => {
      const claimTtlMs = input.claimTtlMs ?? 60_000;
      const job = await store.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs,
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
  };
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
      return services.items.editBulk(requireSelection(payload), payload.operation as never, context, progressOptions);
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

function progress(phase: CatalogAuthoringBulkJobProgress["phase"]): CatalogAuthoringBulkJobProgress {
  return {
    phase,
    completed: phase === "completed" ? 1 : 0,
    total: 1,
    currentName: null,
    status: phase,
  };
}

function catalogAuthoringProgressOptions(
  jobContext: DurableJobExecutionContext<CatalogAuthoringBulkJobProgress, CatalogAuthoringBulkJobResult>,
): BulkLifecycleExecutionOptions {
  return {
    throwIfCancelled: jobContext.throwIfCancelled,
    onProgress: (progressUpdate) => jobContext.checkpointProgress(toCatalogAuthoringProgress(progressUpdate)),
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

async function requireCatalogAuthoringBulkJobClaim(succeeded: Promise<boolean> | boolean) {
  if (!(await succeeded)) {
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
