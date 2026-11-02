import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createDurableJobExecutionContext,
  createPostgresDurableJobStore,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  isDurableJobWorkUnitTerminalAccepted,
  type DurableJobWorkUnitRecord,
  type DurableJobWorkUnitTerminalOutcome,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import { createId } from "@chase-sets/primitives/typed-ids";
import { SettlementDomainError } from "../../../support/runtime-support/common";
import { listPayoutsNeedingReconciliation, recordSettlementReconciliationRun } from "../read-model/queries";
import { isPayoutReconciliationJobHandoff, payoutReconciliationJobProgress } from "./payout-primitives";
import type { PayoutReconciliation } from "./payout-reconciliation";
import type {
  PayoutReconciliationJob,
  PayoutReconciliationJobPayload,
  PayoutReconciliationJobProgress,
  PayoutReconciliationJobResult,
  PayoutRuntimeDeps,
  PayoutServices,
} from "./runtime";

type PayoutReconciliationWorkUnitPayload = Readonly<{
  payoutId: string;
  providerPayoutReference: string | null;
}>;

type PayoutReconciliationWorkUnitResult = Readonly<{
  payoutId: string;
  status: "reconciled" | "ignored" | "skipped" | "failed";
  message: string | null;
}>;

/**
 * Durable payout reconciliation jobs: one work unit per payout needing
 * attention, claimed under lane and lease budgets, with the parent job
 * progress and completed run recorded inside the work-unit store transaction.
 */
export function createPayoutReconciliationJobs(
  deps: Pick<PayoutRuntimeDeps, "db">,
  reconciliation: Pick<PayoutReconciliation, "reconcileProviderPayout" | "reconcilePayoutsNeedingAttention">,
): Pick<
  PayoutServices,
  | "enqueuePayoutReconciliationJob"
  | "getPayoutReconciliationJob"
  | "listPayoutReconciliationJobEvents"
  | "waitForPayoutReconciliationJobEvents"
  | "prunePayoutReconciliationJobRetention"
  | "processNextPayoutReconciliationJob"
  | "getPayoutReconciliationWorkUnitSummary"
> {
  const { reconcileProviderPayout, reconcilePayoutsNeedingAttention } = reconciliation;
  const jobStore = createPostgresDurableJobStore<
    PayoutReconciliationJobPayload,
    PayoutReconciliationJobProgress,
    PayoutReconciliationJobResult
  >(deps.db, {
    jobsTable: "settlement_payout_reconciliation_jobs",
    eventsTable: "settlement_payout_reconciliation_job_events",
  });
  const workUnitStore = createPostgresDurableJobWorkUnitStore<
    PayoutReconciliationJobPayload,
    PayoutReconciliationJobProgress,
    PayoutReconciliationJobResult,
    PayoutReconciliationWorkUnitPayload,
    PayoutReconciliationWorkUnitResult
  >(
    deps.db,
    {
      jobsTable: "settlement_payout_reconciliation_jobs",
      eventsTable: "settlement_payout_reconciliation_job_events",
      workUnitsTable: "settlement_payout_reconciliation_work_units",
    },
    {
      workflowName: "settlement.payout-reconciliation",
    },
  );

  async function processNextPayoutReconciliationWorkUnit(input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }): Promise<number> {
    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["payout-reconciliation"],
      laneName: input.laneName ?? null,
    });
    const claim = claimResult.claim;
    if (!claim) {
      return 0;
    }

    try {
      input.throwIfLeaseLost?.();
      if (input.signal?.aborted) {
        throw new SettlementDomainError("Payout reconciliation job was cancelled.");
      }
      if (!claim.job.eventContext) {
        throw new SettlementDomainError("Payout reconciliation job is missing event context.");
      }
      const providerPayoutReference = claim.unit.payload.providerPayoutReference;
      const outcome: PayoutReconciliationWorkUnitResult = providerPayoutReference
        ? await reconcilePayoutWorkUnit(
            claim.unit.payload.payoutId,
            providerPayoutReference,
            claim.job.eventContext,
            input.signal,
          )
        : {
            payoutId: claim.unit.payload.payoutId,
            status: "skipped",
            message: "Payout has no provider payout reference.",
          };
      await requirePayoutReconciliationJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: outcome.status === "failed" ? "failed" : outcome.status === "skipped" ? "skipped" : "completed",
          unitResult: outcome,
          errorMessage: outcome.status === "failed" ? outcome.message : null,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => payoutReconciliationParentUpdateFromWorkUnits(queryable, claim.job),
        }),
      );
      return 1;
    } catch (error) {
      if (isPayoutReconciliationJobHandoff(error, input)) {
        await workUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        return 0;
      }
      const outcome: PayoutReconciliationWorkUnitResult = {
        payoutId: claim.unit.payload.payoutId,
        status: "failed",
        message: error instanceof Error ? error.message : "Payout reconciliation failed.",
      };
      await requirePayoutReconciliationJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: outcome,
          errorMessage: outcome.message,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => payoutReconciliationParentUpdateFromWorkUnits(queryable, claim.job),
        }),
      );
      return 1;
    }
  }

  async function reconcilePayoutWorkUnit(
    payoutId: string,
    providerPayoutReference: string,
    context: EventStoreContext,
    signal?: AbortSignal,
  ): Promise<PayoutReconciliationWorkUnitResult> {
    const result = await reconcileProviderPayout({ providerPayoutReference }, context, { signal });
    return {
      payoutId,
      status: result.ignored ? "ignored" : "reconciled",
      message: null,
    };
  }

  async function payoutReconciliationParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: PayoutReconciliationJob,
  ): Promise<
    Readonly<{
      parentProgress: PayoutReconciliationJobProgress;
      parentResult: PayoutReconciliationJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await listPayoutReconciliationWorkUnitsForJob(queryable, job.jobId);
    const terminalUnits = units.filter(
      (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
    );
    const outcomes = terminalUnits.flatMap((unit) => (unit.result ? [unit.result] : []));
    const total = Math.max(job.progress.total, units.length, outcomes.length);
    const completeJob = total > 0 && terminalUnits.length >= total;
    const result: PayoutReconciliationJobResult = {
      checked: outcomes.length,
      reconciled: outcomes.filter((outcome) => outcome.status === "reconciled").length,
      ignored: outcomes.filter((outcome) => outcome.status === "ignored").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
      errors: outcomes
        .filter((outcome) => outcome.status === "failed")
        .map((outcome) => ({ payoutId: outcome.payoutId, message: outcome.message ?? "Reconciliation failed." })),
    };
    if (completeJob) {
      await recordSettlementReconciliationRun(queryable, {
        reconciliationRunId: `rec_${job.jobId}`,
        kind: "payouts",
        checked: result.checked,
        reconciled: result.reconciled,
        ignored: result.ignored,
        skipped: result.skipped,
        errorCount: result.errors.length,
        status: result.errors.length > 0 ? "completed-with-errors" : "completed",
        summary: result,
        startedAt: job.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }
    return {
      parentProgress: payoutReconciliationJobProgress(
        completeJob ? "completed" : "processing",
        terminalUnits.length,
        total,
        completeJob ? "Payout reconciliation completed." : "Reconciled payout.",
      ),
      parentResult: result,
      completeJob,
    };
  }

  return {
    enqueuePayoutReconciliationJob: async (params, context) => {
      const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
      const payouts = await listPayoutsNeedingReconciliation(deps.db, {
        accountId: context.audit.forAccountId,
        limit,
      });
      const job = await jobStore.enqueue({
        jobId: createId("job"),
        jobKind: "payout-reconciliation",
        payload: {
          accountId: context.audit.forAccountId,
          limit,
        },
        progress: payoutReconciliationJobProgress("queued", 0, payouts.length, "Payout reconciliation queued."),
        eventContext: context,
      });
      await workUnitStore.enqueue({
        jobId: job.jobId,
        units: payouts.map((payout) => ({
          unitId: payout.payout_id,
          unitKind: "payout-reconciliation",
          payload: {
            payoutId: payout.payout_id,
            providerPayoutReference: payout.provider_payout_reference,
          },
        })),
      });
      return job;
    },
    getPayoutReconciliationJob: (jobId) => jobStore.get(jobId),
    listPayoutReconciliationJobEvents: (jobId, afterSequence = 0) => jobStore.listEvents(jobId, afterSequence),
    waitForPayoutReconciliationJobEvents: (jobId, signal) => jobStore.waitForEvents({ jobId, signal }),
    prunePayoutReconciliationJobRetention: (input = {}) =>
      jobStore.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? payoutReconciliationRetentionCutoff(7),
        limit: input.limit,
      }),
    processNextPayoutReconciliationJob: async (input) => {
      const processedUnit = await processNextPayoutReconciliationWorkUnit(input);
      if (processedUnit > 0) {
        return processedUnit;
      }

      const unitSummary = await workUnitStore.summarize();
      if (unitSummary.queued > 0 || unitSummary.running > 0) {
        return 0;
      }

      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: ["payout-reconciliation"],
      });
      if (!claimed) {
        return 0;
      }

      try {
        input.throwIfLeaseLost?.();
        if (input.signal?.aborted) {
          throw new SettlementDomainError("Payout reconciliation job was cancelled.");
        }
        if (!claimed.eventContext) {
          throw new SettlementDomainError("Payout reconciliation job is missing event context.");
        }

        await requirePayoutReconciliationJobClaim(
          jobStore.updateProgress({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
            progress: payoutReconciliationJobProgress("processing", 0, claimed.payload.limit, "Reconciling payouts."),
          }),
        );
        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Payout reconciliation job was cancelled.",
          claimLostMessage: "Payout reconciliation job claim was lost before the status update completed.",
        });
        const result = await reconcilePayoutsNeedingAttention(
          {
            accountId: claimed.payload.accountId,
            limit: claimed.payload.limit,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
          },
          claimed.eventContext,
          jobContext,
        );
        await requirePayoutReconciliationJobClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: payoutReconciliationJobProgress(
              "completed",
              result.checked,
              result.checked,
              "Payout reconciliation completed.",
            ),
            result,
          }),
        );
        return 1;
      } catch (error) {
        if (isPayoutReconciliationJobHandoff(error, input)) {
          return 0;
        }
        await requirePayoutReconciliationJobClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Payout reconciliation failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Payout reconciliation failed.",
          }),
        );
        return 1;
      }
    },
    getPayoutReconciliationWorkUnitSummary: (input = {}) => workUnitStore.summarize(input),
  };
}

async function requirePayoutReconciliationJobClaim(
  succeeded: Promise<boolean | DurableJobWorkUnitTerminalOutcome> | boolean | DurableJobWorkUnitTerminalOutcome,
) {
  const outcome = await succeeded;
  if (!isDurableJobWorkUnitTerminalAccepted(outcome)) {
    throw new SettlementDomainError("Payout reconciliation job claim was lost before the status update completed.");
  }
}

function payoutReconciliationRetentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

async function listPayoutReconciliationWorkUnitsForJob(
  queryable: PgQueryable,
  jobId: string,
): Promise<
  readonly DurableJobWorkUnitRecord<PayoutReconciliationWorkUnitPayload, PayoutReconciliationWorkUnitResult>[]
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
     FROM settlement_payout_reconciliation_work_units
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
    claimedUntil: row.claimed_until == null ? null : formatTimestamp(row.claimed_until),
    attemptCount: Number(row.attempt_count),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
    completedAt: row.completed_at == null ? null : formatTimestamp(row.completed_at),
  }));
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
