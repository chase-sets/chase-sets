import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  catalogScopeSyncUnitIsFastForwardable,
  computeCatalogSyncScopeKey,
  type CatalogScopeSyncUnitObservedStatus,
  type CatalogScopeSyncUnitState,
} from "../../scope-sync-state/domain/state";
import {
  listCatalogScopeSyncState,
  readCatalogScopeSyncUnitState,
  upsertCatalogScopeSyncUnitState,
} from "../../scope-sync-state/read-model/queries";
import { listAcceptedProviderScopeMappingsByScopeRecord } from "../../provider-scope-mapping/read-model/queries";
import { type CatalogIntegrationRolloutControlPolicy } from "./catalog-integration-rollout-controls";
import {
  catalogSyncAcceptedScopeMappingFromRow,
  normalizeCatalogSyncScope,
  previewCatalogSyncProviderParticipation,
  type CatalogSyncAcceptedScopeMapping,
  type CatalogSyncProviderParticipationPreview,
  type CatalogSyncScope,
} from "./catalog-sync-scope-planner";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationIntegrationJob,
  CatalogSyncRunFanoutResult,
  CatalogSyncRun,
  CatalogSyncRunDurableJobRecord,
  CatalogSyncRunChildJobLink,
  CatalogSyncRunSelectedUnitSnapshot,
  CatalogScopeSyncUnitStateReadModel,
  CatalogSyncRunChildJob,
  IntegrationJobServices,
  SourceObservationIntegrationJobStore,
  CatalogSyncRunJobStore,
} from "./source-observation-runtime-contracts";
import {
  jobMatchesContext,
  toSourceObservationIntegrationJob,
  selectedCatalogSyncRunUnits,
  catalogSyncRunIdempotencyKey,
  catalogSyncRunFanoutProgress,
  catalogScopeSyncStateDescriptor,
  compactStringRecord,
  recordFromUnknownStringRecord,
  catalogScopeSyncObservedStatusFromChildLink,
  childExecutionScopesMatch,
  catalogSyncRunChildStatus,
  catalogSyncRunProgress,
  catalogSyncRunOperatorStatus,
} from "./source-observation-job-serialization";

export type CatalogScopeSyncStateRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy;
  providerAdapterRegistry: ProviderAdapterRegistry;
  integrationJobStore: SourceObservationIntegrationJobStore;
  catalogSyncRunStore: CatalogSyncRunJobStore;
}>;

/**
 * Scope participation preview plus the durable Catalog scope sync state that
 * outlives the run that produced it. Split from the fanout enqueue below so the
 * integration-job runtime can record child-job state without depending on the
 * run enqueue path, which in turn depends on the integration-job runtime.
 */
export function createCatalogScopeSyncStateRuntime({
  deps,
  profileVersions,
  rolloutControlPolicy,
  providerAdapterRegistry,
  integrationJobStore,
  catalogSyncRunStore,
}: CatalogScopeSyncStateRuntimeDeps) {
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

  const services: Pick<
    IntegrationJobServices,
    "previewCatalogSyncScope" | "getCatalogSyncRun" | "getCatalogScopeSyncState"
  > = {
    previewCatalogSyncScope,
    getCatalogSyncRun,
    getCatalogScopeSyncState,
  };

  return {
    services,
    previewCatalogSyncScope,
    resolveCatalogScopeSyncFastForwardJobId,
    recordCatalogScopeSyncStateForRun,
    recordCatalogScopeSyncStateForChildJob,
    findReusableCatalogSyncRun,
    completeCatalogSyncRunFanout,
    toCatalogSyncRun,
  };
}

export type CatalogScopeSyncStateRuntime = ReturnType<typeof createCatalogScopeSyncStateRuntime>;

export type CatalogSyncRunFanoutRuntimeDeps = Readonly<{
  catalogSyncRunStore: CatalogSyncRunJobStore;
  scopeSyncState: Omit<CatalogScopeSyncStateRuntime, "services" | "recordCatalogScopeSyncStateForChildJob">;
  enqueueIntegrationJob: IntegrationJobServices["enqueueIntegrationJob"];
}>;

/**
 * Catalog sync run fanout: plan the participating provider units for a scope
 * and enqueue one integration job per unit, reusing settled state and in-flight
 * runs rather than re-running a scope that has not changed.
 */
export function createCatalogSyncRunFanoutRuntime({
  catalogSyncRunStore,
  scopeSyncState,
  enqueueIntegrationJob,
}: CatalogSyncRunFanoutRuntimeDeps) {
  const {
    previewCatalogSyncScope,
    resolveCatalogScopeSyncFastForwardJobId,
    recordCatalogScopeSyncStateForRun,
    findReusableCatalogSyncRun,
    completeCatalogSyncRunFanout,
    toCatalogSyncRun,
  } = scopeSyncState;

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

  const services: Pick<IntegrationJobServices, "enqueueCatalogSyncRun"> = {
    enqueueCatalogSyncRun,
  };

  return { services };
}
