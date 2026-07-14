import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type {
  CatalogSyncProviderParticipationPreview,
  CatalogSyncScope,
} from "../../source-observations/api/catalog-sync-scope-planner";
import type { CatalogSyncRun, SourceObservationIntegrationJob } from "../../source-observations/api/runtime";
import {
  assertScopeSyncBatchPreviewCurrent,
  type ScopeSyncBatchBudget,
  type ScopeSyncBatchPreview,
  type ScopeSyncBatchSelection,
} from "../domain/batch";
import { createScopeSyncBatchStore, type ScopeSyncBatchSnapshot } from "../read-model/store";
import { createScopeSyncBatchPlanner } from "./planner";
import { createScopeSyncBatchWorker } from "./worker";

export type ScopeSyncBatchServices = ReturnType<typeof createScopeSyncBatchRuntime>;

export function createScopeSyncBatchRuntime(deps: {
  db: PgQueryable;
  previewCatalogSyncScope: (input: {
    scope: CatalogSyncScope;
    context: EventStoreContext;
    includeOperationalGates?: boolean;
  }) => Promise<CatalogSyncProviderParticipationPreview>;
  enqueueCatalogSyncRun: (input: { scope: CatalogSyncScope; context: EventStoreContext }) => Promise<CatalogSyncRun>;
  getCatalogSyncRun: (input: { syncRunId: string; context: EventStoreContext }) => Promise<CatalogSyncRun | null>;
  cancelIntegrationJob: (input: {
    jobId: string;
    context: EventStoreContext;
  }) => Promise<SourceObservationIntegrationJob>;
  now?: () => string;
}) {
  const store = createScopeSyncBatchStore(deps.db);
  const planner = createScopeSyncBatchPlanner({
    db: deps.db,
    previewCatalogSyncScope: deps.previewCatalogSyncScope,
    now: deps.now,
  });
  const worker = createScopeSyncBatchWorker({
    repository: store.repository,
    enqueueCatalogSyncRun: deps.enqueueCatalogSyncRun,
    getCatalogSyncRun: deps.getCatalogSyncRun,
  });

  async function preview(input: {
    selection: ScopeSyncBatchSelection;
    budget?: Partial<ScopeSyncBatchBudget> | null;
    context: EventStoreContext;
  }): Promise<ScopeSyncBatchPreview> {
    return (await planner.resolve(input)).preview;
  }

  async function confirm(input: {
    selection: ScopeSyncBatchSelection;
    budget?: Partial<ScopeSyncBatchBudget> | null;
    planFingerprint: string;
    context: EventStoreContext;
  }): Promise<ScopeSyncBatchSnapshot> {
    const current = await planner.resolve(input);
    assertScopeSyncBatchPreviewCurrent(input.planFingerprint, current.preview);
    const settled = await store.findCompletedByFingerprint(current.preview.planFingerprint, input.context);
    if (settled && (await remainsSettled(settled, input.context))) return settled;
    return store.create({
      batchId: createId("job"),
      preview: current.preview,
      plans: current.plans,
      context: input.context,
    });
  }

  async function remainsSettled(batch: ScopeSyncBatchSnapshot, context: EventStoreContext): Promise<boolean> {
    const runs = await Promise.all(
      batch.units.map((unit) =>
        unit.syncRunId ? deps.getCatalogSyncRun({ syncRunId: unit.syncRunId, context }) : Promise.resolve(null),
      ),
    );
    return runs.every(
      (run) => run?.status === "completed" && run.childJobs.every((child) => child.status === "completed"),
    );
  }

  async function cancel(input: {
    batchId: string;
    context: EventStoreContext;
  }): Promise<ScopeSyncBatchSnapshot | null> {
    const batch = await store.get(input.batchId, input.context);
    if (!batch) return null;
    for (const unit of batch.units.filter((candidate) => candidate.state === "running" && candidate.syncRunId)) {
      const run = await deps.getCatalogSyncRun({ syncRunId: unit.syncRunId!, context: input.context });
      for (const child of run?.childJobs ?? []) {
        if (child.childJobId && (child.status === "queued" || child.status === "running" || child.status === "stale")) {
          try {
            await deps.cancelIntegrationJob({ jobId: child.childJobId, context: input.context });
          } catch {
            // The child may have settled concurrently; the following batch state write remains authoritative.
          }
        }
      }
    }
    return store.cancel(input.batchId, input.context);
  }

  return {
    preview,
    confirm,
    get: (input: { batchId: string; context: EventStoreContext }) => store.get(input.batchId, input.context),
    cancel,
    resume: (input: { batchId: string; context: EventStoreContext }) => store.resume(input.batchId, input.context),
    retryUnit: (input: { batchId: string; scopeRecordId: string; context: EventStoreContext }) =>
      store.retryUnit(input.batchId, input.scopeRecordId, input.context),
    processNextScopeSyncBatch: worker.processNext,
  };
}
