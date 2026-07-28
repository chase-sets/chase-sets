import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { isDurableJobHandoffError } from "@chase-sets/platform-runtime/durable-job-store";
import { type DurableJobWorkUnitRecord } from "@chase-sets/platform-runtime/durable-job-work-units";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  getSourceObservationDetail,
  listSourceObservationIdsForReapply,
  listSourceObservationIdsForPromotion,
  type SourceObservationFilterScope,
} from "../read-model/queries";
import { type CatalogIntegrationRolloutControlPolicy } from "./governance/catalog-integration-rollout-controls";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  BulkSourceObservationProgress,
  SourceObservationBulkJobResult,
  SourceObservationBulkJob,
  SourceObservationBulkWorkUnitPayload,
  SourceObservationBulkWorkUnitResult,
  SourceObservationReapplyProfileMode,
  SourceObservationIntegrationProfileSnapshot,
  SourceObservationBulkJobAction,
  SourceObservationJobRunContext,
  BulkReviewJobServices,
  SourceObservationBulkReviewJobStore,
  SourceObservationBulkReviewWorkUnitStore,
} from "./source-observation-runtime-contracts";
import {
  recordBulkReviewWorkUnitTelemetry,
  recordBulkReviewControlPlaneTelemetry,
} from "./providers/provider-option-queries";
import { normalizeReapplyProfileMode } from "./governance/catalog-integration-control-plane-readiness";
import {
  jobMatchesContext,
  toSourceObservationBulkJob,
  uniqueObservationIds,
  bulkProgress,
  summarizePromotionOutcomes,
  summarizeReapplyOutcomes,
  normalizeBulkJobScope,
  isJobRunCancelled,
  toClaimedSourceObservationBulkJobFromWorkUnitClaim,
  throwIfJobRunCancelled,
  createSourceObservationWorkUnitSideEffectRunner,
  failedBulkWorkUnitOutcome,
  workUnitTerminalState,
  requireSourceObservationJobClaim,
  SourceObservationJobCancelledError,
  bulkResultOutcomes,
  isReapplyOutcome,
  isPromotionOutcome,
  parseJsonField,
  formatDateLike,
  toSourceObservationJobEvent,
  terminalPromotionOutcomeFromEvents,
} from "./source-observation-job-serialization";
import {
  commonProfileSnapshot,
  requireBulkJobReapplyProfileMode,
  requireCatalogPromotionProfileVersion,
  requireCatalogReapplyActiveProfileVersion,
  snapshotCatalogReapplyProfileVersion,
} from "./source-observation-promotion-execution";
import type { SourceObservationPromotionReapplyRuntime } from "./source-observation-promotion-reapply-runtime";

export type SourceObservationBulkReviewJobRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy;
  bulkReviewJobStore: SourceObservationBulkReviewJobStore;
  bulkReviewWorkUnitStore: SourceObservationBulkReviewWorkUnitStore;
  promotionReapply: Pick<
    SourceObservationPromotionReapplyRuntime,
    "promoteObservationIds" | "reapplyObservationIds" | "rejectObservationIds" | "deferObservationIds"
  >;
}>;

/**
 * Bulk-review durable job facet: enqueue, claim, and drive the work units that
 * apply the bulk promote/reapply/reject/defer actions owned by the
 * promotion/reapply runtime.
 */
export function createSourceObservationBulkReviewJobRuntime({
  deps,
  profileVersions,
  rolloutControlPolicy,
  bulkReviewJobStore,
  bulkReviewWorkUnitStore,
  promotionReapply,
}: SourceObservationBulkReviewJobRuntimeDeps) {
  const { promoteObservationIds, reapplyObservationIds, rejectObservationIds, deferObservationIds } = promotionReapply;

  async function enqueueBulkReviewJob(input: {
    action: SourceObservationBulkJobAction;
    observationIds?: readonly string[];
    scope?: SourceObservationFilterScope;
    reason?: string | null;
    reapplyProfileMode?: SourceObservationReapplyProfileMode | null;
    context: EventStoreContext;
  }): Promise<SourceObservationBulkJob> {
    if (input.action === "promote") {
      rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: input.scope?.provider });
    }
    if (input.action === "reapply") {
      rolloutControlPolicy.assertAllowed({ capability: "reapply", providerKey: input.scope?.provider });
    }
    const observationIds = uniqueObservationIds(input.observationIds ?? []);
    const selectionMode = observationIds.length > 0 ? "ids" : "filter";
    const scope = selectionMode === "filter" ? normalizeBulkJobScope(input.scope ?? {}) : {};
    const reapplyProfileMode =
      input.action === "reapply"
        ? (normalizeReapplyProfileMode(input.reapplyProfileMode) ?? "current-active-profile")
        : null;
    const jobId = createId("job");
    const unitObservationIds =
      selectionMode === "ids" ? observationIds : await listSourceObservationIdsForBulkAction(input.action, scope);
    const unitProfileSnapshots =
      input.action === "reapply" && reapplyProfileMode === "current-active-profile" && selectionMode === "ids"
        ? await snapshotSelectedReapplyProfiles(unitObservationIds)
        : new Map<string, SourceObservationIntegrationProfileSnapshot | null>();
    const profileSnapshot =
      input.action === "reapply" && reapplyProfileMode === "current-active-profile"
        ? selectionMode === "ids"
          ? commonProfileSnapshot([...unitProfileSnapshots.values()])
          : snapshotCatalogReapplyProfileVersion(
              await requireCatalogReapplyActiveProfileVersion(profileVersions, scope.provider, null),
            )
        : null;
    const progress = bulkProgress(0, unitObservationIds.length, null, null, "queued");
    const job = await bulkReviewJobStore.enqueue({
      jobId,
      jobKind: input.action,
      payload: {
        action: input.action,
        selectionMode,
        observationIds,
        scope,
        reason: input.reason?.trim() || null,
        profileSnapshot,
        reapplyProfileMode,
      },
      progress,
      eventContext: input.context,
    });
    await bulkReviewWorkUnitStore.enqueue({
      jobId,
      units: unitObservationIds.map((observationId) => ({
        unitId: observationId,
        unitKind: input.action,
        payload: {
          observationId,
          profileSnapshot: unitProfileSnapshots.get(observationId) ?? profileSnapshot,
          reapplyProfileMode,
        },
      })),
    });

    return toSourceObservationBulkJob(job);
  }

  async function snapshotSelectedReapplyProfiles(
    observationIds: readonly string[],
  ): Promise<Map<string, SourceObservationIntegrationProfileSnapshot | null>> {
    const snapshots = new Map<string, SourceObservationIntegrationProfileSnapshot | null>();
    const profilesByProvider = new Map<string, SourceObservationIntegrationProfileSnapshot>();

    for (const observationId of observationIds) {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation) {
        snapshots.set(observationId, null);
        continue;
      }

      const providerKey = observation.provider_key.trim().toLowerCase();
      const cacheKey = `${providerKey}:${observation.normalized.kind}`;
      let snapshot = profilesByProvider.get(cacheKey);
      if (!snapshot) {
        snapshot = snapshotCatalogReapplyProfileVersion(
          await requireCatalogPromotionProfileVersion(profileVersions, providerKey, observation.normalized),
        );
        profilesByProvider.set(cacheKey, snapshot);
      }
      snapshots.set(observationId, snapshot);
    }

    return snapshots;
  }

  async function processNextBulkReviewJob(
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

    const claimResult = await bulkReviewWorkUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["promote", "reject", "defer", "reapply"],
      laneName: input.laneName ?? null,
    });
    if (!claimResult.claim) {
      const reconciled = await reconcileTerminalBulkReviewJobs();
      return reconciled > 0 ? reconciled : 0;
    }
    const claim = claimResult.claim;
    const claimed = toClaimedSourceObservationBulkJobFromWorkUnitClaim(claim);

    try {
      throwIfJobRunCancelled(input);
      const runBulkReviewSideEffect = createSourceObservationWorkUnitSideEffectRunner(bulkReviewWorkUnitStore, claim, {
        signal: input.signal,
        throwIfLeaseLost: input.throwIfLeaseLost,
        claimTtlMs: input.claimTtlMs,
      });
      const context = claimed.eventContext;

      const observationId = claim.unit.payload.observationId;
      const itemResult =
        claimed.action === "reapply"
          ? await reapplyObservationIds({
              observationIds: [observationId],
              context,
              runReapplyObservation: runBulkReviewSideEffect,
              reapplyProfileMode: requireBulkJobReapplyProfileMode(
                claim.unit.payload.reapplyProfileMode ?? claimed.reapplyProfileMode,
                claimed.jobId,
              ),
              profileSnapshot: claim.unit.payload.profileSnapshot ?? claimed.profileSnapshot,
            })
          : claimed.action === "promote"
            ? await promoteObservationIds({
                observationIds: [observationId],
                context,
                runPromoteObservation: runBulkReviewSideEffect,
              })
            : claimed.action === "defer"
              ? await deferObservationIds({
                  observationIds: [observationId],
                  reason: claimed.reason ?? "Deferred during review.",
                  context,
                  runDeferObservation: runBulkReviewSideEffect,
                })
              : await rejectObservationIds({
                  observationIds: [observationId],
                  reason: claimed.reason ?? "Rejected during review.",
                  context,
                  runRejectObservation: runBulkReviewSideEffect,
                });
      const outcome = itemResult.outcomes[0] ?? failedBulkWorkUnitOutcome(claimed.action, observationId, "No outcome.");
      const terminalState = workUnitTerminalState(outcome);
      throwIfJobRunCancelled(input);

      await requireSourceObservationJobClaim(
        bulkReviewWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: terminalState,
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: claimed.progress,
          parentResult: claimed.result,
          resolveParentUpdate: (queryable) => bulkReviewParentUpdateFromWorkUnits(queryable, claimed),
        }),
      );
      recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, claimed.action, terminalState);
      recordBulkReviewControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, outcome);
      return 1;
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error, input)) {
        await bulkReviewWorkUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        recordBulkReviewWorkUnitTelemetry(
          deps.sourceObservationTelemetry,
          claimed.action,
          error instanceof SourceObservationJobCancelledError ? "cancelled" : "released",
        );
        return 0;
      }

      const outcome = failedBulkWorkUnitOutcome(
        claimed.action,
        claim.unit.payload.observationId,
        error instanceof Error ? error.message : "Bulk review job failed.",
      );
      await requireSourceObservationJobClaim(
        bulkReviewWorkUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: outcome,
          errorMessage: outcome.reason,
          parentProgress: { ...claimed.progress, phase: "processing" },
          parentResult: claimed.result,
          resolveParentUpdate: (queryable) => bulkReviewParentUpdateFromWorkUnits(queryable, claimed),
        }),
      );
      recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, claimed.action, "failed");
      recordBulkReviewControlPlaneTelemetry(deps.sourceObservationTelemetry, claimed, outcome);
      return 1;
    }
  }

  async function reconcileTerminalBulkReviewJobs(): Promise<number> {
    const activeJobs = await bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "defer", "reapply"] });
    let reconciled = 0;
    for (const rawJob of activeJobs) {
      const summary = await bulkReviewWorkUnitStore.summarize({ jobId: rawJob.jobId });
      if (summary.queued > 0 || summary.running > 0 || summary.expiredClaims > 0) {
        continue;
      }

      const job = toSourceObservationBulkJob(rawJob);
      const parentUpdate = await bulkReviewParentUpdateFromWorkUnits(deps.db, job);
      if (!parentUpdate.completeJob) {
        continue;
      }

      const completed = await bulkReviewWorkUnitStore.reconcileTerminalParent({
        jobId: job.jobId,
        parentProgress: parentUpdate.parentProgress,
        parentResult: parentUpdate.parentResult,
        completeJob: true,
        resolveParentUpdate: (queryable) => bulkReviewParentUpdateFromWorkUnits(queryable, job),
      });
      if (completed) {
        reconciled += 1;
        recordBulkReviewWorkUnitTelemetry(deps.sourceObservationTelemetry, job.action, "reconciled");
      }
    }

    return reconciled;
  }

  async function listSourceObservationIdsForBulkAction(
    action: SourceObservationBulkJobAction,
    scope: SourceObservationFilterScope,
  ): Promise<readonly string[]> {
    return action === "reapply"
      ? listSourceObservationIdsForReapply(deps.db, scope)
      : listSourceObservationIdsForPromotion(deps.db, scope);
  }

  async function bulkReviewParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: SourceObservationBulkJob,
  ): Promise<
    Readonly<{
      parentProgress: BulkSourceObservationProgress;
      parentResult: SourceObservationBulkJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await listBulkReviewWorkUnitsForJob(queryable, job.jobId);
    const unitIds = new Set(units.map((unit) => unit.unitId));
    const carriedOutcomes = bulkResultOutcomes(job.result).filter((outcome) => !unitIds.has(outcome.observationId));
    const unitOutcomes = units
      .filter((unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped")
      .flatMap((unit) => (unit.result ? [unit.result] : []));
    const outcomes = [...carriedOutcomes, ...unitOutcomes];
    const allUnitsTerminal = units.every(
      (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
    );
    const resolvedTotal = Math.max(carriedOutcomes.length + units.length, outcomes.length);
    const total = allUnitsTerminal ? resolvedTotal : Math.max(job.progress.total, resolvedTotal);
    const completeJob = outcomes.length >= total && allUnitsTerminal;
    const latestOutcome = outcomes[outcomes.length - 1] ?? null;
    const parentProgress = bulkProgress(
      outcomes.length,
      total,
      null,
      latestOutcome?.status ?? null,
      completeJob ? "completed" : "processing",
    );
    const parentResult =
      job.action === "reapply"
        ? summarizeReapplyOutcomes(total, outcomes.filter(isReapplyOutcome))
        : summarizePromotionOutcomes(total, outcomes.filter(isPromotionOutcome));

    return { parentProgress, parentResult, completeJob };
  }

  async function listBulkReviewWorkUnitsForJob(
    queryable: PgQueryable,
    jobId: string,
  ): Promise<
    readonly DurableJobWorkUnitRecord<SourceObservationBulkWorkUnitPayload, SourceObservationBulkWorkUnitResult>[]
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
       FROM catalog_source_observation_bulk_review_work_units
       WHERE job_id = $1
       ORDER BY created_at ASC, unit_id ASC`,
      [jobId],
    );

    return result.rows.map((row) => ({
      jobId,
      unitId: row.unit_id,
      unitKind: row.unit_kind,
      state: row.state,
      payload: parseJsonField(row.payload, "work unit payload"),
      result: row.result == null ? null : parseJsonField(row.result, "work unit result"),
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

  const services: BulkReviewJobServices = {
    enqueueBulkReviewJob,
    getBulkReviewJob: async (jobId, context) => {
      const job = await bulkReviewJobStore.get(jobId);
      if (job && context && !jobMatchesContext(job, context)) {
        return null;
      }
      return job ? toSourceObservationBulkJob(job) : null;
    },
    listBulkReviewJobEvents: async (jobId, afterSequence = 0) =>
      (await bulkReviewJobStore.listEvents(jobId, afterSequence)).map(toSourceObservationJobEvent),
    getBulkReviewPromotionOutcome: async (jobId) =>
      terminalPromotionOutcomeFromEvents(
        jobId,
        (await bulkReviewJobStore.listEvents(jobId)).map(toSourceObservationJobEvent),
      ),
    waitForBulkReviewJobEvents: (jobId, signal) => bulkReviewJobStore.waitForEvents({ jobId, signal }),
    listActiveBulkReviewJobs: async ({ context }) =>
      (await bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "defer", "reapply"] }))
        .filter((job) => jobMatchesContext(job, context))
        .map(toSourceObservationBulkJob),
    processNextBulkReviewJob,
    getBulkReviewWorkUnitSummary: (input = {}) => bulkReviewWorkUnitStore.summarize({ jobId: input.jobId ?? null }),
  };

  return { services };
}
