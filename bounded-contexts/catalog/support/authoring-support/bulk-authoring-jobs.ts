import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPostgresDurableJobStore, type DurableJobEvent } from "@chase-sets/platform-runtime/durable-job-store";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { BulkSelection } from "../runtime-support/bulk-lifecycle";
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
  processNext: (input: { claimOwnerId: string; claimTtlMs?: number; services: CatalogServices }) => Promise<boolean>;
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
        await store.fail({
          jobId: job.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: progress("failed"),
          errorMessage: "Catalog authoring bulk job is missing event context.",
        });
        return true;
      }

      try {
        await store.updateProgress({
          jobId: job.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: progress("running"),
        });
        const result = await executeCatalogAuthoringBulkJob(input.services, job.payload, context);
        await store.complete({
          jobId: job.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: progress("completed"),
          result,
        });
      } catch (error) {
        await store.fail({
          jobId: job.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: progress("failed"),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
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
) {
  switch (payload.kind) {
    case "catalog.authoring.dimensions.lifecycle":
      return services.dimensions.bulkLifecycle.execute(requireSelection(payload), payload.action, context);
    case "catalog.authoring.fields.lifecycle":
      return services.fields.bulkLifecycle.execute(requireSelection(payload), payload.action, context);
    case "catalog.authoring.components.lifecycle":
      return services.components.bulkLifecycle.execute(requireSelection(payload), payload.action, context);
    case "catalog.authoring.blueprints.lifecycle":
      return services.blueprints.bulkLifecycle.execute(requireSelection(payload), payload.action, context);
    case "catalog.authoring.categories.lifecycle":
      return services.categories.bulkLifecycle.execute(requireSelection(payload), payload.action, context);
    case "catalog.authoring.reference-types.lifecycle":
      return services.referenceData.referenceTypeBulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
      );
    case "catalog.authoring.reference-records.lifecycle":
      return services.referenceData.referenceRecordBulkLifecycle.execute(
        requireSelection(payload),
        payload.action,
        context,
      );
    case "catalog.authoring.items.lifecycle":
      return services.items.bulkLifecycle.execute(requireSelection(payload), payload.action, context);
    case "catalog.authoring.items.publish":
      return services.items.publishBulk(payload.itemIds ?? [], context);
    case "catalog.authoring.items.edit":
      return services.items.editBulk(requireSelection(payload), payload.operation as never, context);
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
