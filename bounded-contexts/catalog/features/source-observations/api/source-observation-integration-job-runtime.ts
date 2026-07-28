import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  isDurableJobHandoffError,
} from "@chase-sets/platform-runtime/durable-job-store";
import { type DurableJobWorkUnitRecord } from "@chase-sets/platform-runtime/durable-job-work-units";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { listSourceObservationIdsForReapply } from "../read-model/queries";
import {
  type CatalogProviderIntegrationProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import { type CatalogIntegrationRolloutControlPolicy } from "./governance/catalog-integration-rollout-controls";
import {
  SourceObservationIntegrationJobLifecycleCommandError,
  OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE,
} from "./source-observation-runtime-contracts";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  BulkSourceObservationProgress,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationJob,
  SourceObservationIntegrationWorkUnitPayload,
  SourceObservationIntegrationJobOutcome,
  SourceObservationReapplyProfileMode,
  SourceObservationJobRunContext,
  SourceObservationIntegrationJobScope,
  SourceObservationIntegrationImportPreview,
  SourceObservationIntegrationJobAction,
  SourceObservationIntegrationDurableJobRecord,
  IntegrationJobServices,
  SourceObservationIntegrationJobStore,
  SourceObservationIntegrationWorkUnitStore,
} from "./source-observation-runtime-contracts";
import {
  recordIntegrationJobTelemetry,
  sourceObservationIntegrationJobTelemetryResult,
  recordIntegrationJobControlPlaneTelemetry,
} from "./providers/provider-option-queries";
import { normalizeReapplyProfileMode } from "./governance/catalog-integration-control-plane-readiness";
import {
  normalizeOptionalKey,
  profileSelectorFromScope,
  jobMatchesContext,
  toSourceObservationIntegrationJob,
  bulkProgress,
  isJobRunCancelled,
  throwIfJobRunCancelled,
  createSourceObservationWorkUnitSideEffectRunner,
  requireSourceObservationJobClaim,
  SourceObservationJobCancelledError,
  parseJsonField,
  formatDateLike,
  normalizeIntegrationJobScope,
  reusableActiveIntegrationJobOperatorStatuses,
  integrationScopeToObservationScope,
  isDurableJobClaimExpired,
  integrationJobOperatorStatus,
  retryableIntegrationJobResult,
  isOperatorCancelledIntegrationJob,
  toClaimedSourceObservationIntegrationJob,
  integrationReapplyOutcomeFromBulkOutcome,
  summarizeIntegrationJobOutcomes,
  createSourceObservationSideEffectRunner,
  toSourceObservationJobEvent,
} from "./source-observation-job-serialization";
import type { ClaimedSourceObservationIntegrationJob } from "./source-observation-job-serialization";
import {
  defaultSourceObservationImportProviderKey,
  integrationProfileSnapshotKey,
  requireCatalogImportProfileVersion,
  requireCatalogImportProfileVersionForJob,
  requireCatalogReapplyActiveProfileVersion,
  requireIntegrationJobReapplyProfileMode,
  snapshotCatalogProfileVersion,
  snapshotCatalogReapplyProfileVersion,
} from "./source-observation-promotion-execution";
import type { CatalogScopeSyncStateRuntime } from "./source-observation-catalog-sync-run-runtime";
import type { SourceObservationProviderImportRuntime } from "./source-observation-provider-import-runtime";
import type { SourceObservationPromotionReapplyRuntime } from "./source-observation-promotion-reapply-runtime";

const INTEGRATION_REAPPLY_JOB_BATCH_SIZE = 10;

export type SourceObservationIntegrationJobRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy;
  integrationJobStore: SourceObservationIntegrationJobStore;
  integrationWorkUnitStore: SourceObservationIntegrationWorkUnitStore;
  promotionReapply: Pick<SourceObservationPromotionReapplyRuntime, "reapplyObservationIds">;
  scopeSyncState: Pick<CatalogScopeSyncStateRuntime, "recordCatalogScopeSyncStateForChildJob">;
  providerImport: SourceObservationProviderImportRuntime;
}>;

/**
 * Provider integration job facet: import/reapply job lifecycle commands, the
 * claim loop, and the per-turn processors that drive provider-adapter imports
 * and reapply work units.
 */
export function createSourceObservationIntegrationJobRuntime({
  deps,
  profileVersions,
  rolloutControlPolicy,
  integrationJobStore,
  integrationWorkUnitStore,
  promotionReapply,
  scopeSyncState,
  providerImport,
}: SourceObservationIntegrationJobRuntimeDeps) {
  const { reapplyObservationIds } = promotionReapply;
  const { recordCatalogScopeSyncStateForChildJob } = scopeSyncState;
  const {
    resolveProviderAdapterImportTargets,
    previewProviderAdapterIntegrationImportTargets,
    importProviderAdapterIntegrationTarget,
  } = providerImport;

  async function listIntegrationWorkUnitsForJob(
    queryable: PgQueryable,
    jobId: string,
  ): Promise<
    readonly DurableJobWorkUnitRecord<
      SourceObservationIntegrationWorkUnitPayload,
      SourceObservationIntegrationJobOutcome
    >[]
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
       FROM catalog_source_observation_integration_work_units
       WHERE job_id = $1
       ORDER BY created_at ASC, unit_id ASC`,
      [jobId],
    );

    return result.rows.map((row) => ({
      jobId,
      unitId: row.unit_id,
      unitKind: row.unit_kind,
      state: row.state,
      payload: parseJsonField(row.payload, "integration work unit payload"),
      result: row.result == null ? null : parseJsonField(row.result, "integration work unit result"),
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

  async function previewIntegrationImport(input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationImportPreview> {
    const scope = normalizeIntegrationJobScope(input.scope);
    rolloutControlPolicy.assertAllowed({ capability: "import", providerKey: scope.provider });
    rolloutControlPolicy.assertAllowed({ capability: "provider-transport", providerKey: scope.provider });
    const providerProfileVersion = await requireCatalogImportProfileVersion(
      profileVersions,
      scope.provider,
      profileSelectorFromScope(scope),
    );
    const providerProfile = providerProfileVersion.profile;

    const targets = await previewProviderAdapterIntegrationImportTargets(scope, providerProfileVersion);

    return {
      action: "import",
      providerKey: providerProfile.providerKey,
      scope,
      profileSnapshot: snapshotCatalogProfileVersion(providerProfileVersion),
      targetCount: targets.length,
      targets,
    };
  }

  async function enqueueIntegrationJob(input: {
    action: SourceObservationIntegrationJobAction;
    scope: SourceObservationIntegrationJobScope;
    syncRunId?: string | null;
    reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const scope = normalizeIntegrationJobScope(input.scope);
    rolloutControlPolicy.assertAllowed({
      capability: input.action === "import" ? "import" : "reapply",
      providerKey: scope.provider,
    });
    const importProfileVersion =
      input.action === "import"
        ? await requireCatalogImportProfileVersion(profileVersions, scope.provider, profileSelectorFromScope(scope))
        : null;
    const reapplyProfileMode: SourceObservationReapplyProfileMode | null =
      input.action === "reapply"
        ? (normalizeReapplyProfileMode(input.reapplyProfileMode) ?? "current-active-profile")
        : null;
    const profileSnapshot =
      importProfileVersion === null
        ? reapplyProfileMode === null
          ? null
          : reapplyProfileMode === "current-active-profile"
            ? snapshotCatalogReapplyProfileVersion(
                await requireCatalogReapplyActiveProfileVersion(
                  profileVersions,
                  scope.provider,
                  profileSelectorFromScope(scope),
                ),
              )
            : null
        : snapshotCatalogProfileVersion(importProfileVersion);

    const existingJob = (await integrationJobStore.listActive({ jobKinds: [input.action] }))
      .filter((job) => jobMatchesContext(job, input.context))
      .map(toSourceObservationIntegrationJob)
      .filter((job) => reusableActiveIntegrationJobOperatorStatuses.has(job.operatorStatus))
      .find(
        (job) =>
          JSON.stringify(job.scope) === JSON.stringify(scope) &&
          job.reapplyProfileMode === reapplyProfileMode &&
          integrationProfileSnapshotKey(job.profileSnapshot, job.jobId) ===
            integrationProfileSnapshotKey(profileSnapshot, "new integration job"),
      );
    if (existingJob) {
      return existingJob;
    }

    const jobId = createId("job");
    const unitObservationIds =
      input.action === "reapply"
        ? await listSourceObservationIdsForReapply(deps.db, integrationScopeToObservationScope(scope))
        : [];
    const progress = bulkProgress(0, unitObservationIds.length, null, null, "queued");

    const job = await integrationJobStore.enqueue({
      jobId,
      jobKind: input.action,
      payload: {
        action: input.action,
        scope,
        syncRunId: normalizeOptionalKey(input.syncRunId),
        profileSnapshot,
        reapplyProfileMode,
      },
      progress,
      eventContext: input.context,
    });
    if (input.action === "reapply") {
      await integrationWorkUnitStore.enqueue({
        jobId,
        units: unitObservationIds.map((observationId) => ({
          unitId: observationId,
          unitKind: "reapply",
          payload: { observationId, profileSnapshot, reapplyProfileMode },
        })),
      });
    }

    return toSourceObservationIntegrationJob(job);
  }

  async function retryIntegrationJob(input: {
    jobId: string;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const job = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
    if (job.status === "running" && isDurableJobClaimExpired(job)) {
      return resumeIntegrationJob(input);
    }
    if (job.status === "queued" || job.status === "running") {
      return toSourceObservationIntegrationJob(job);
    }

    const operatorStatus = integrationJobOperatorStatus(job);
    if (operatorStatus === "completed") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Completed provider import jobs without failed outcomes cannot be retried.",
      );
    }

    const retryResult = retryableIntegrationJobResult(job.result, job.progress.total);
    const requeued = await integrationJobStore.requeue({
      jobId: job.jobId,
      progress: bulkProgress(retryResult.outcomes.length, retryResult.requested, null, null, "queued"),
      result: retryResult,
      errorMessage: null,
      allowedStatuses: ["failed", "completed"],
    });

    if (!requeued) {
      const currentJob = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
      if (currentJob.status === "queued" || currentJob.status === "running") {
        return toSourceObservationIntegrationJob(currentJob);
      }
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Provider import job could not be requeued for retry.",
      );
    }

    const retriedJob = toSourceObservationIntegrationJob(requeued);
    // "Per-provider retry from the scope page without touching the settled
    // providers": this only ever touches the ONE unit whose job was just
    // requeued, keyed through its parent sync run — every other unit's
    // durable state is untouched.
    await recordCatalogScopeSyncStateForChildJob({
      job: retriedJob,
      status: "queued",
      errorMessage: null,
      recordedAt: new Date().toISOString(),
    });
    return retriedJob;
  }

  async function resumeIntegrationJob(input: {
    jobId: string;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const job = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
    if (job.status === "queued") {
      return toSourceObservationIntegrationJob(job);
    }
    if (job.status !== "running") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Only queued or stale running provider import jobs can be resumed.",
      );
    }
    if (!isDurableJobClaimExpired(job)) {
      return toSourceObservationIntegrationJob(job);
    }

    const requeued = await integrationJobStore.requeue({
      jobId: job.jobId,
      progress: {
        ...job.progress,
        phase: "queued",
      },
      result: job.result ?? undefined,
      errorMessage: null,
      allowedStatuses: ["running"],
      requireExpiredClaim: true,
    });

    if (!requeued) {
      return toSourceObservationIntegrationJob(await requireImportIntegrationLifecycleJob(input.jobId, input.context));
    }

    const resumedJob = toSourceObservationIntegrationJob(requeued);
    await recordCatalogScopeSyncStateForChildJob({
      job: resumedJob,
      status: "queued",
      errorMessage: null,
      recordedAt: new Date().toISOString(),
    });
    return resumedJob;
  }

  async function cancelIntegrationJob(input: {
    jobId: string;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const job = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
    if (isOperatorCancelledIntegrationJob(job)) {
      return toSourceObservationIntegrationJob(job);
    }
    if (job.status !== "queued" && job.status !== "running") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Only queued or running provider import jobs can be cancelled.",
      );
    }

    const cancelled = await integrationJobStore.cancel({
      jobId: job.jobId,
      progress: {
        ...job.progress,
        phase: "failed",
      },
      errorMessage: OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE,
      allowedStatuses: ["queued", "running"],
    });

    if (!cancelled) {
      const currentJob = await requireImportIntegrationLifecycleJob(input.jobId, input.context);
      if (isOperatorCancelledIntegrationJob(currentJob)) {
        return toSourceObservationIntegrationJob(currentJob);
      }
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Provider import job could not be cancelled from its current state.",
      );
    }

    return toSourceObservationIntegrationJob(cancelled);
  }

  async function requireImportIntegrationLifecycleJob(
    jobId: string,
    context: EventStoreContext,
  ): Promise<SourceObservationIntegrationDurableJobRecord> {
    const job = await integrationJobStore.get(jobId);
    if (!job || !jobMatchesContext(job, context)) {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "job_not_found",
        "Provider import job was not found for the current operator context.",
      );
    }
    if (job.payload.action !== "import") {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_action",
        "Only provider import jobs support retry, resume, and cancel lifecycle commands.",
      );
    }

    return job;
  }

  async function processNextIntegrationJob(
    input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
    } & SourceObservationJobRunContext,
  ): Promise<number> {
    if (isJobRunCancelled(input)) {
      return 0;
    }
    if (!rolloutControlPolicy.decide({ capability: "worker-job-processing" }).allowed) {
      return 0;
    }

    const claimedJob = await integrationJobStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      jobKinds: ["import"],
    });
    let claimed = claimedJob ? toClaimedSourceObservationIntegrationJob(claimedJob) : null;
    if (!claimed) {
      const processedReapplyUnit = await processIntegrationReapplyWorkUnit(input);
      if (processedReapplyUnit > 0) {
        return processedReapplyUnit;
      }
      const unitSummary = await integrationWorkUnitStore.summarize();
      if (unitSummary.queued > 0 || unitSummary.running > 0) {
        return 0;
      }
      const reapplyClaimedJob = await integrationJobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: ["reapply"],
      });
      claimed = reapplyClaimedJob ? toClaimedSourceObservationIntegrationJob(reapplyClaimedJob) : null;
      if (!claimed) {
        return 0;
      }
    }

    try {
      throwIfJobRunCancelled(input);
      const turnResult =
        claimed.action === "import"
          ? await processIntegrationImportJobTurn({
              job: claimed,
              claimTtlMs: input.claimTtlMs,
              context: input,
            })
          : await processIntegrationReapplyJobTurn({
              job: claimed,
              claimTtlMs: input.claimTtlMs,
              context: input,
            });

      throwIfJobRunCancelled(input);
      if (turnResult.complete) {
        await requireSourceObservationJobClaim(
          integrationJobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: bulkProgress(turnResult.result.requested, turnResult.result.requested, null, null, "completed"),
            result: turnResult.result,
          }),
        );
        recordIntegrationJobTelemetry(
          deps.sourceObservationTelemetry,
          claimed.action,
          sourceObservationIntegrationJobTelemetryResult(turnResult.result),
        );
        recordIntegrationJobControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, turnResult.result);
        await recordCatalogScopeSyncStateForChildJob({
          job: {
            ...claimed,
            status: "completed",
            result: turnResult.result,
            completedAt: new Date().toISOString(),
          },
          status: turnResult.result.failed > 0 ? "partial" : "completed",
          errorMessage: null,
          recordedAt: new Date().toISOString(),
        });
      } else {
        await requireSourceObservationJobClaim(
          integrationJobStore.releaseClaim({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: turnResult.progress,
            result: turnResult.result,
          }),
        );
        recordIntegrationJobTelemetry(deps.sourceObservationTelemetry, claimed.action, "released");
      }
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        recordIntegrationJobTelemetry(
          deps.sourceObservationTelemetry,
          claimed.action,
          error instanceof SourceObservationJobCancelledError ? "cancelled" : "released",
        );
        return 0;
      }

      const failureMessage = error instanceof Error ? error.message : "Integration job failed.";
      await requireSourceObservationJobClaim(
        integrationJobStore.fail({
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: { ...claimed.progress, phase: "failed" },
          errorMessage: failureMessage,
        }),
      );
      recordIntegrationJobTelemetry(deps.sourceObservationTelemetry, claimed.action, "failed");
      recordIntegrationJobControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, null, "failed");
      await recordCatalogScopeSyncStateForChildJob({
        job: { ...claimed, status: "failed", completedAt: new Date().toISOString() },
        status: "failed",
        errorMessage: failureMessage,
        recordedAt: new Date().toISOString(),
      });
      return 1;
    }
  }

  async function processIntegrationReapplyWorkUnit(
    input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
    } & SourceObservationJobRunContext,
  ): Promise<number> {
    const claimResult = await integrationWorkUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["reapply"],
      laneName: input.laneName ?? null,
    });
    const claim = claimResult.claim;
    if (!claim) {
      return 0;
    }

    const job = toSourceObservationIntegrationJob(claim.job);
    const context = claim.job.eventContext;
    try {
      throwIfJobRunCancelled(input);
      if (!context) {
        throw new Error("Source Observation integration job is missing event context.");
      }
      const runReapplyObservation = createSourceObservationWorkUnitSideEffectRunner(integrationWorkUnitStore, claim, {
        signal: input.signal,
        throwIfLeaseLost: input.throwIfLeaseLost,
        claimTtlMs: input.claimTtlMs,
      });
      const itemResult = await reapplyObservationIds({
        observationIds: [claim.unit.payload.observationId],
        context,
        runReapplyObservation,
        reapplyProfileMode: requireIntegrationJobReapplyProfileMode(
          claim.unit.payload.reapplyProfileMode ?? job.reapplyProfileMode,
          job.jobId,
        ),
        profileSnapshot: claim.unit.payload.profileSnapshot ?? job.profileSnapshot,
      });
      const outcome = integrationReapplyOutcomeFromBulkOutcome(
        job,
        claim.unit.payload.observationId,
        itemResult.outcomes[0],
        await defaultSourceObservationImportProviderKey(profileVersions),
      );
      await requireSourceObservationJobClaim(
        integrationWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: outcome.status === "failed" ? "failed" : outcome.status === "skipped" ? "skipped" : "completed",
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => integrationParentUpdateFromWorkUnits(queryable, job),
        }),
      );
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        await integrationWorkUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        return 0;
      }
      const outcome: SourceObservationIntegrationJobOutcome = {
        providerKey: job.scope.provider || (await defaultSourceObservationImportProviderKey(profileVersions)),
        languageCode: job.scope.language || "",
        expansionId: claim.unit.payload.observationId,
        status: "failed",
        observed: 0,
        reapplied: 0,
        reason: error instanceof Error ? error.message : "Source Observation integration reapply failed.",
      };
      await requireSourceObservationJobClaim(
        integrationWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => integrationParentUpdateFromWorkUnits(queryable, job),
        }),
      );
      return 1;
    }
  }

  async function integrationParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: SourceObservationIntegrationJob,
  ): Promise<
    Readonly<{
      parentProgress: BulkSourceObservationProgress;
      parentResult: SourceObservationIntegrationJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await listIntegrationWorkUnitsForJob(queryable, job.jobId);
    const unitIds = new Set(units.map((unit) => unit.unitId));
    const carriedOutcomes = (job.result?.outcomes ?? []).filter((outcome) => !unitIds.has(outcome.expansionId ?? ""));
    const unitOutcomes = units
      .filter((unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped")
      .flatMap((unit) => (unit.result ? [unit.result] : []));
    const outcomes = [...carriedOutcomes, ...unitOutcomes];
    const total = Math.max(job.progress.total, carriedOutcomes.length + units.length, outcomes.length);
    const completeJob =
      total > 0 &&
      outcomes.length >= total &&
      units.every((unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped");
    const result = summarizeIntegrationJobOutcomes(total, outcomes);
    const latestOutcome = outcomes[outcomes.length - 1] ?? null;
    return {
      parentProgress: bulkProgress(
        outcomes.length,
        total,
        null,
        latestOutcome?.status ?? null,
        completeJob ? "completed" : "processing",
      ),
      parentResult: result,
      completeJob,
    };
  }

  async function processIntegrationImportJobTurn(input: {
    job: ClaimedSourceObservationIntegrationJob;
    claimTtlMs: number;
    context: SourceObservationJobRunContext;
  }): Promise<
    Readonly<{
      complete: boolean;
      progress: BulkSourceObservationProgress;
      result: SourceObservationIntegrationJobResult;
    }>
  > {
    throwIfJobRunCancelled(input.context);
    const scope = normalizeIntegrationJobScope(input.job.scope);
    rolloutControlPolicy.assertAllowed({ capability: "import", providerKey: scope.provider });
    rolloutControlPolicy.assertAllowed({ capability: "provider-transport", providerKey: scope.provider });
    const providerProfileVersion = await requireCatalogImportProfileVersionForJob(
      profileVersions,
      scope.provider,
      input.job.profileSnapshot,
      profileSelectorFromScope(scope),
    );
    const providerProfile = providerProfileVersion.profile;

    return processProviderAdapterIntegrationImportJobTurn({
      job: input.job,
      scope,
      providerProfile,
      providerProfileVersion,
      claimTtlMs: input.claimTtlMs,
      context: input.context,
    });
  }

  async function processIntegrationReapplyJobTurn(input: {
    job: ClaimedSourceObservationIntegrationJob;
    claimTtlMs: number;
    context: SourceObservationJobRunContext;
  }): Promise<
    Readonly<{
      complete: boolean;
      progress: BulkSourceObservationProgress;
      result: SourceObservationIntegrationJobResult;
    }>
  > {
    throwIfJobRunCancelled(input.context);
    rolloutControlPolicy.assertAllowed({ capability: "reapply", providerKey: input.job.scope.provider });
    const scope = integrationScopeToObservationScope(input.job.scope);
    const previousResult = input.job.result ?? summarizeIntegrationJobOutcomes(input.job.progress.total, []);
    const completedObservationIds = new Set(
      previousResult.outcomes.map((outcome) => outcome.expansionId).filter(Boolean),
    );
    const remainingObservationIds = (await listSourceObservationIdsForReapply(deps.db, scope)).filter(
      (observationId) => !completedObservationIds.has(observationId),
    );
    throwIfJobRunCancelled(input.context);
    const total = Math.max(previousResult.requested, previousResult.outcomes.length + remainingObservationIds.length);
    const batchObservationIds = remainingObservationIds.slice(0, INTEGRATION_REAPPLY_JOB_BATCH_SIZE);

    if (batchObservationIds.length === 0) {
      const result = summarizeIntegrationJobOutcomes(total, previousResult.outcomes);
      return {
        complete: true,
        progress: bulkProgress(result.requested, result.requested, null, null, "completed"),
        result,
      };
    }

    const progressHandler = async (progress: BulkSourceObservationProgress) => {
      throwIfJobRunCancelled(input.context);
      const persistedProgress = bulkProgress(
        previousResult.outcomes.length + progress.completed,
        total,
        progress.currentName,
        progress.status,
        progress.phase === "failed" ? "failed" : "processing",
      );
      await requireSourceObservationJobClaim(
        integrationJobStore.updateProgress({
          jobId: input.job.jobId,
          claimOwnerId: input.job.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          progress: persistedProgress,
        }),
      );
    };
    const jobContext = createDurableJobExecutionContext(integrationJobStore, {
      jobId: input.job.jobId,
      claimOwnerId: input.job.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      signal: input.context.signal,
      throwIfLeaseLost: input.context.throwIfLeaseLost,
      cancelledMessage: "Source Observation job run was cancelled.",
      claimLostMessage: "Source Observation job claim was lost before the status update completed.",
    });
    throwIfJobRunCancelled(input.context);
    const batchResult = await reapplyObservationIds({
      observationIds: batchObservationIds,
      context: input.job.eventContext,
      onProgress: progressHandler,
      runReapplyObservation: createSourceObservationSideEffectRunner(jobContext),
      reapplyProfileMode: requireIntegrationJobReapplyProfileMode(input.job.reapplyProfileMode, input.job.jobId),
      profileSnapshot: input.job.profileSnapshot,
    });
    throwIfJobRunCancelled(input.context);

    const defaultProviderKey = await defaultSourceObservationImportProviderKey(profileVersions);
    const outcomes: SourceObservationIntegrationJobOutcome[] = [
      ...previousResult.outcomes,
      ...batchResult.outcomes.map((outcome) => ({
        providerKey: input.job.scope.provider || defaultProviderKey,
        languageCode: input.job.scope.language || "",
        expansionId: outcome.observationId,
        status: outcome.status,
        observed: 0,
        reapplied: outcome.status === "reapplied" ? 1 : 0,
        reason: outcome.reason,
      })),
    ];
    const result = summarizeIntegrationJobOutcomes(total, outcomes);

    return {
      complete:
        result.outcomes.length >= result.requested || remainingObservationIds.length <= batchObservationIds.length,
      progress: bulkProgress(result.outcomes.length, result.requested, null, null, "processing"),
      result,
    };
  }

  async function processProviderAdapterIntegrationImportJobTurn(input: {
    job: ClaimedSourceObservationIntegrationJob;
    scope: SourceObservationIntegrationJobScope;
    providerProfile: CatalogProviderIntegrationProfile;
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    claimTtlMs: number;
    context: SourceObservationJobRunContext;
  }): Promise<
    Readonly<{
      complete: boolean;
      progress: BulkSourceObservationProgress;
      result: SourceObservationIntegrationJobResult;
    }>
  > {
    throwIfJobRunCancelled(input.context);
    const targets = await resolveProviderAdapterImportTargets(input.scope, input.providerProfileVersion);
    throwIfJobRunCancelled(input.context);
    const previousResult = input.job.result ?? summarizeIntegrationJobOutcomes(targets.length, []);
    const completedTargetIds = new Set(
      previousResult.outcomes
        .filter((outcome) => outcome.status !== "failed")
        .map((outcome) => outcome.expansionId)
        .filter(Boolean),
    );
    const nextTarget = targets.find((target) => !completedTargetIds.has(target.targetId));

    if (!nextTarget) {
      const result = summarizeIntegrationJobOutcomes(targets.length, previousResult.outcomes);
      return {
        complete: true,
        progress: bulkProgress(result.requested, result.requested, null, null, "completed"),
        result,
      };
    }

    const jobContext = createDurableJobExecutionContext(integrationJobStore, {
      jobId: input.job.jobId,
      claimOwnerId: input.job.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      signal: input.context.signal,
      throwIfLeaseLost: input.context.throwIfLeaseLost,
      cancelledMessage: "Source Observation job run was cancelled.",
      claimLostMessage: "Source Observation job claim was lost before the status update completed.",
    });
    const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
      minRenewIntervalMs: Math.max(1_000, Math.floor(input.claimTtlMs / 3)),
      completed: (progress) => progress.completed,
      isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
    });
    const recordRenewIntervalMs = Math.max(1_000, Math.floor(input.claimTtlMs / 3));
    let lastRecordRenewedAt = 0;

    await progressCheckpoint.flush(bulkProgress(previousResult.outcomes.length, targets.length, nextTarget.name));

    const outcome = await importProviderAdapterIntegrationTarget({
      target: nextTarget,
      providerProfile: input.providerProfile,
      providerProfileVersion: input.providerProfileVersion,
      syncRunId: input.job.syncRunId,
      context: input.job.eventContext,
      beforeRecordObservation: async () => {
        throwIfJobRunCancelled(input.context);
        const now = Date.now();
        if (lastRecordRenewedAt === 0 || now - lastRecordRenewedAt >= recordRenewIntervalMs) {
          await jobContext.renew();
          lastRecordRenewedAt = Date.now();
        }
      },
      runRecordObservation: createSourceObservationSideEffectRunner(jobContext),
      onProgress: async (targetProgress) => {
        throwIfJobRunCancelled(input.context);
        await progressCheckpoint.checkpoint(
          bulkProgress(
            previousResult.outcomes.length,
            targets.length,
            targetProgress.currentName ?? nextTarget.name,
            null,
            "processing",
          ),
        );
      },
    });
    const result = summarizeIntegrationJobOutcomes(targets.length, [...previousResult.outcomes, outcome]);

    return {
      complete: result.outcomes.length >= result.requested,
      progress: bulkProgress(result.outcomes.length, result.requested, nextTarget.name, outcome.status),
      result,
    };
  }

  const services: Omit<
    IntegrationJobServices,
    "previewCatalogSyncScope" | "enqueueCatalogSyncRun" | "getCatalogSyncRun" | "getCatalogScopeSyncState"
  > = {
    previewIntegrationImport,
    enqueueIntegrationJob,
    retryIntegrationJob,
    resumeIntegrationJob,
    cancelIntegrationJob,
    getIntegrationJob: async (jobId, context) => {
      const job = await integrationJobStore.get(jobId);
      if (job && context && !jobMatchesContext(job, context)) {
        return null;
      }
      return job ? toSourceObservationIntegrationJob(job) : null;
    },
    listIntegrationJobEvents: async (jobId, afterSequence = 0) =>
      (await integrationJobStore.listEvents(jobId, afterSequence)).map(toSourceObservationJobEvent),
    waitForIntegrationJobEvents: (jobId, signal) => integrationJobStore.waitForEvents({ jobId, signal }),
    listActiveIntegrationJobs: async ({ context }) => {
      if (!context) {
        return [];
      }

      return (await integrationJobStore.listActive({ jobKinds: ["import", "reapply"] }))
        .filter((job) => jobMatchesContext(job, context))
        .map(toSourceObservationIntegrationJob);
    },
    listRecentIntegrationJobs: async ({ context, limit }) => {
      if (!context) {
        return [];
      }

      return (
        await integrationJobStore.listRecent({
          jobKinds: ["import", "reapply"],
          eventContext: context,
          limit,
        })
      )
        .filter((job) => jobMatchesContext(job, context))
        .map(toSourceObservationIntegrationJob);
    },
    processNextIntegrationJob,
    getIntegrationWorkUnitSummary: (input = {}) => integrationWorkUnitStore.summarize({ jobId: input.jobId ?? null }),
  };

  return { services, enqueueIntegrationJob };
}
