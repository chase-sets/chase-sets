import { createHash } from "node:crypto";
import type { ContextProjectionGroup, ContextSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import type { ProjectionRunContext, ProjectorRunResult } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PlatformControlPlane } from "./control-plane";
import {
  createPostgresWorkSignalWaiter,
  type PostgresWorkSignalNotification,
  type PostgresWorkSignalWaiter,
  type WorkSignalObserver,
} from "./work-signal-composite";
import type {
  PostgresWorkSignalStore,
  ProjectionWakeIntentRecord,
  WorkSignalCleanupResult,
  ProjectionWakeIntentWorkSignalPayload,
  WorkSignalPriorityLane,
} from "./work-signal-store";
import { PROJECTION_WAKE_INTENT_WORK_SIGNAL_CHANNEL } from "./work-signal-store";
import {
  createProjectionGroupRunnerLeaseName,
  createProjectionGroupWorkerRunner,
  DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS,
  ProjectionGroupRevisionStaleError,
  tryRunWithRenewedLease,
  type WorkerRunner,
} from "./worker";

export const PROJECTION_WAKE_SCHEDULER_RUNNER_PREFIX = "projection-wake-scheduler";
export const WORK_SIGNAL_CLEANUP_RUNNER_NAME = "work-signals.cleanup";

export const DEFAULT_PROJECTION_WAKE_MAX_CLAIMS_PER_RUN = 10;
export const DEFAULT_PROJECTION_WAKE_MAX_RUNS_PER_CLAIM = 20;
export const DEFAULT_PROJECTION_WAKE_CLAIM_TTL_MS = 120_000;
export const DEFAULT_PROJECTION_WAKE_RETRY_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_PROJECTION_WAKE_RETRY_BACKOFF_MAX_MS = 60_000;
export const DEFAULT_PROJECTION_WAKE_DEFERRED_RETRY_MS = 1_000;
export const DEFAULT_PROJECTION_WAKE_UNKNOWN_TARGET_RETRY_MS = 30_000;
export const DEFAULT_PROJECTION_WAKE_REVISION_STALE_RETRY_MS = 30_000;
export const DEFAULT_PROJECTION_WAKE_MAX_ATTEMPTS = 10;
export const DEFAULT_WORK_SIGNAL_CLEANUP_INTERVAL_MS = 60_000;
export const DEFAULT_PROJECTION_WAKE_PUSH_DISPATCH_WAIT_TIMEOUT_MS = 60_000;

export type ProjectionWakeSchedulerStore = Pick<
  PostgresWorkSignalStore,
  | "claimNextProjectionWakeIntent"
  | "renewProjectionWakeIntent"
  | "completeProjectionWakeIntent"
  | "deferProjectionWakeIntent"
  | "failProjectionWakeIntent"
  | "recordCheckpointReady"
>;

export type ProjectionWakeSchedulerLaneConfig = Readonly<{
  lane: WorkSignalPriorityLane;
  runnerCount: number;
}>;

export type ProjectionWakeIntentLifecycleEvent = Readonly<{
  workerId: string;
  laneRunnerName: string;
  wakeIntentId: string;
  priorityLane: WorkSignalPriorityLane;
  origin: ProjectionWakeIntentRecord["origin"];
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  requiredPosition: string;
  attemptCount: number;
  queueAgeMs: number;
}>;

export type ProjectionWakeIntentCompletedEvent = ProjectionWakeIntentLifecycleEvent &
  Readonly<{
    outcome: "ran" | "already-satisfied";
    checkpointPosition: string;
    requeued: boolean;
    processingDurationMs: number;
  }>;

export type ProjectionWakeIntentRetryEvent = ProjectionWakeIntentLifecycleEvent &
  Readonly<{
    retryAfterMs: number;
  }>;

export type ProjectionWakeSchedulerObserver = Readonly<{
  wakeIntentClaimed?: (event: ProjectionWakeIntentLifecycleEvent) => void;
  wakeIntentCompleted?: (event: ProjectionWakeIntentCompletedEvent) => void;
  wakeIntentNotReady?: (event: ProjectionWakeIntentRetryEvent) => void;
  wakeIntentDeferred?: (event: ProjectionWakeIntentRetryEvent) => void;
  wakeIntentUnknownTarget?: (event: ProjectionWakeIntentRetryEvent) => void;
  wakeIntentRunFailed?: (event: ProjectionWakeIntentRetryEvent & Readonly<{ error: unknown }>) => void;
  wakeIntentAttemptsExhausted?: (event: ProjectionWakeIntentLifecycleEvent) => void;
  wakeIntentClaimLost?: (event: ProjectionWakeIntentLifecycleEvent) => void;
  checkpointReadinessRecordFailed?: (event: ProjectionWakeIntentLifecycleEvent & Readonly<{ error: unknown }>) => void;
  workSignalCleanupCompleted?: (event: Readonly<{ result: WorkSignalCleanupResult }>) => void;
}>;

export type ProjectionWakePushDispatchWaitResult = "notified" | "timeout" | "aborted" | "listener-unavailable";

export type ProjectionWakePushDispatchEvent = Readonly<{
  result: ProjectionWakePushDispatchWaitResult;
}>;

export type ProjectionWakePushDispatchObserver = Readonly<{
  waitEnded?: (event: ProjectionWakePushDispatchEvent) => void;
  nudgeScheduled?: (event: Readonly<{ targetContextName: string | null }>) => void;
}>;

export type ProjectionWakePushDispatcher = Readonly<{
  done: Promise<void>;
  stop: () => Promise<void>;
}>;

export type ProjectionWakePushDispatcherInput = Readonly<{
  waiter: PostgresWorkSignalWaiter;
  nudge: () => void;
  waitTimeoutMs?: number;
  targetContextNames?: readonly string[];
  signal?: AbortSignal;
  observer?: ProjectionWakePushDispatchObserver;
}>;

export type PostgresProjectionWakePushDispatcherInput = Omit<ProjectionWakePushDispatcherInput, "waiter"> &
  Readonly<{
    listenerPool: PgTransactionalPool;
    listenRetryCooldownMs?: number;
    listenerObserver?: Pick<WorkSignalObserver, "listenerUnavailable" | "notificationReceived" | "waitEnded">;
  }>;

export type ProjectionWakeSchedulerOptions = Readonly<{
  workerId: string;
  controlPlane: PlatformControlPlane;
  workSignalStore: ProjectionWakeSchedulerStore;
  projectionGroups: readonly ContextProjectionGroup[];
  lanes?: readonly ProjectionWakeSchedulerLaneConfig[];
  maxClaimsPerRun?: number;
  maxRunsPerClaim?: number;
  claimTtlMs?: number;
  leaseTtlMs?: number;
  leaseRenewIntervalMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
  statementTimeoutMs?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  deferredRetryMs?: number;
  unknownTargetRetryMs?: number;
  revisionStaleRetryMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  observer?: ProjectionWakeSchedulerObserver;
}>;

type ProjectionGroupIndexEntry = Readonly<{
  group: ContextProjectionGroup;
  runner: WorkerRunner;
  subscriptionsByCheckpointKey: ReadonlyMap<string, ContextSubscriptionRunner>;
}>;

type ProcessedWakeIntentOutcome =
  | "completed"
  | "already-satisfied"
  | "deferred"
  | "not-ready"
  | "unknown-target"
  | "claim-lost"
  | "run-failed";

const DEFAULT_LANES: readonly ProjectionWakeSchedulerLaneConfig[] = [
  { lane: "hot", runnerCount: 1 },
  { lane: "standard", runnerCount: 1 },
  { lane: "bulk", runnerCount: 1 },
];

export function createProjectionWakeSchedulerRunners(options: ProjectionWakeSchedulerOptions): readonly WorkerRunner[] {
  const now = options.now ?? (() => new Date());
  const maxClaimsPerRun = Math.max(
    1,
    Math.floor(options.maxClaimsPerRun ?? DEFAULT_PROJECTION_WAKE_MAX_CLAIMS_PER_RUN),
  );
  const maxRunsPerClaim = Math.max(
    1,
    Math.floor(options.maxRunsPerClaim ?? DEFAULT_PROJECTION_WAKE_MAX_RUNS_PER_CLAIM),
  );
  const claimTtlMs = Math.max(1_000, Math.floor(options.claimTtlMs ?? DEFAULT_PROJECTION_WAKE_CLAIM_TTL_MS));
  const leaseTtlMs = Math.max(1_000, Math.floor(options.leaseTtlMs ?? 30_000));
  const leaseRenewIntervalMs = Math.max(250, Math.floor(options.leaseRenewIntervalMs ?? 10_000));
  const statementTimeoutMs =
    options.statementTimeoutMs === undefined ? undefined : Math.max(1, Math.floor(options.statementTimeoutMs));
  const idleInTransactionSessionTimeoutMs =
    options.idleInTransactionSessionTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS;
  const retryBackoffBaseMs = Math.max(
    0,
    Math.floor(options.retryBackoffBaseMs ?? DEFAULT_PROJECTION_WAKE_RETRY_BACKOFF_BASE_MS),
  );
  const retryBackoffMaxMs = Math.max(
    retryBackoffBaseMs,
    Math.floor(options.retryBackoffMaxMs ?? DEFAULT_PROJECTION_WAKE_RETRY_BACKOFF_MAX_MS),
  );
  const deferredRetryMs = Math.max(0, Math.floor(options.deferredRetryMs ?? DEFAULT_PROJECTION_WAKE_DEFERRED_RETRY_MS));
  const unknownTargetRetryMs = Math.max(
    0,
    Math.floor(options.unknownTargetRetryMs ?? DEFAULT_PROJECTION_WAKE_UNKNOWN_TARGET_RETRY_MS),
  );
  const revisionStaleRetryMs = Math.max(
    0,
    Math.floor(options.revisionStaleRetryMs ?? DEFAULT_PROJECTION_WAKE_REVISION_STALE_RETRY_MS),
  );
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_PROJECTION_WAKE_MAX_ATTEMPTS));
  const lanes = (options.lanes ?? DEFAULT_LANES).filter((lane) => lane.runnerCount > 0);
  const groupIndex = buildProjectionGroupIndex(options.projectionGroups);
  const hostedTargetContextNames = [
    ...new Set(options.projectionGroups.map((group) => group.targetContextName)),
  ].sort();

  if (groupIndex.size === 0 || hostedTargetContextNames.length === 0) {
    return [];
  }

  // Lane runner leases are single-flight platform-wide, but claims are scoped to
  // THIS worker's hosted target contexts. When the fleet sharing the wake store
  // is heterogeneous in hosted contexts — rolling deploys, an estate cutover
  // (mixed DOKS revisions on one control DB), a `WORKER_WAKE_DISABLED_PROJECTIONS`
  // divergence, or a runtime-profile split — a lane lease won by a worker that
  // does not host a given target context would starve that context's intents at
  // ANY capacity: the holder's claim filter never matches them and no other
  // worker may run the lane. Binding the lease identity to the hosted-context
  // cohort keeps single-flight within a homogeneous cohort (unchanged connection
  // budget) while guaranteeing every hosted context always has a lane runner
  // that can claim it.
  const hostedContextCohortToken = createHostedContextCohortToken(hostedTargetContextNames);

  const computeRetryBackoffMs = (attemptCount: number): number => {
    if (retryBackoffBaseMs <= 0) {
      return 0;
    }

    const exponent = Math.min(Math.max(attemptCount - 1, 0), 10);
    return Math.min(retryBackoffMaxMs, retryBackoffBaseMs * 2 ** exponent);
  };

  const failIntent = async (
    intent: ProjectionWakeIntentRecord,
    retryAfterMs: number,
    error: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!intent.claimFencingToken) {
      return false;
    }

    return options.workSignalStore.failProjectionWakeIntent({
      wakeIntentId: intent.wakeIntentId,
      claimOwnerId: requireClaimOwnerId(intent),
      claimFencingToken: intent.claimFencingToken,
      retryAfterMs,
      error,
    });
  };

  const deferIntent = async (
    intent: ProjectionWakeIntentRecord,
    retryAfterMs: number,
    error: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!intent.claimFencingToken) {
      return false;
    }

    return options.workSignalStore.deferProjectionWakeIntent({
      wakeIntentId: intent.wakeIntentId,
      claimOwnerId: requireClaimOwnerId(intent),
      claimFencingToken: intent.claimFencingToken,
      retryAfterMs,
      error,
    });
  };

  const completeIntentAndRecordReadiness = async (
    intent: ProjectionWakeIntentRecord,
    event: ProjectionWakeIntentLifecycleEvent,
    checkpointPosition: bigint,
    outcome: "ran" | "already-satisfied",
    claimedAtMs: number,
  ): Promise<ProcessedWakeIntentOutcome> => {
    try {
      await options.workSignalStore.recordCheckpointReady({
        checkpointKey: intent.checkpointKey,
        sourceContextName: intent.sourceContextName,
        targetContextName: intent.targetContextName,
        projectionName: intent.projectionName,
        readyPosition: checkpointPosition,
        correlationId: intent.correlationId,
        metadata: {
          recordedBy: PROJECTION_WAKE_SCHEDULER_RUNNER_PREFIX,
          wakeIntentId: intent.wakeIntentId,
          origin: intent.origin,
        },
      });
    } catch (error) {
      options.observer?.checkpointReadinessRecordFailed?.({ ...event, error });
    }

    if (!intent.claimFencingToken) {
      options.observer?.wakeIntentClaimLost?.(event);
      return "claim-lost";
    }

    const completion = await options.workSignalStore.completeProjectionWakeIntent({
      wakeIntentId: intent.wakeIntentId,
      claimOwnerId: requireClaimOwnerId(intent),
      claimFencingToken: intent.claimFencingToken,
    });
    if (completion === "lost") {
      options.observer?.wakeIntentClaimLost?.(event);
      return "claim-lost";
    }

    options.observer?.wakeIntentCompleted?.({
      ...event,
      outcome,
      checkpointPosition: checkpointPosition.toString(),
      requeued: completion === "requeued",
      processingDurationMs: Math.max(0, now().getTime() - claimedAtMs),
    });
    return outcome === "ran" ? "completed" : "already-satisfied";
  };

  const processClaimedWakeIntent = async (
    intent: ProjectionWakeIntentRecord,
    laneRunnerName: string,
    context?: ProjectionRunContext,
  ): Promise<ProcessedWakeIntentOutcome> => {
    const claimedAtMs = now().getTime();
    const event = createLifecycleEvent(options.workerId, laneRunnerName, intent, now());
    const entry = groupIndex.get(createProjectionGroupKey(intent.targetContextName, intent.projectionName));
    const subscription = entry?.subscriptionsByCheckpointKey.get(intent.checkpointKey);
    if (!entry || !subscription) {
      await failIntent(intent, unknownTargetRetryMs, {
        reason: entry ? "unknown-checkpoint-key" : "unknown-projection-group",
        workerId: options.workerId,
      });
      options.observer?.wakeIntentUnknownTarget?.({ ...event, retryAfterMs: unknownTargetRetryMs });
      return "unknown-target";
    }

    const requiredPosition = intent.claimedRequiredPosition ?? intent.requiredPosition;
    const statusBefore = await subscription.refreshStatus();
    const positionBefore = BigInt(statusBefore.lastGlobalPosition);
    if (positionBefore >= requiredPosition) {
      return completeIntentAndRecordReadiness(intent, event, positionBefore, "already-satisfied", claimedAtMs);
    }

    let checkpointPosition = positionBefore;
    let blockedStreamCount = statusBefore.blockedStreamCount;
    let poisonEventCount = statusBefore.poisonEventCount;
    let runOutcome: Readonly<{ acquired: boolean }>;
    let wakeClaimActive = true;
    let wakeClaimRenewalStopped = false;
    let wakeClaimRenewalInFlight = false;
    const wakeClaimAbortController = new AbortController();
    const abortFromParent = () => {
      wakeClaimActive = false;
      wakeClaimAbortController.abort();
    };
    if (context?.signal?.aborted) {
      abortFromParent();
    } else {
      context?.signal?.addEventListener("abort", abortFromParent, { once: true });
    }
    const throwIfWakeClaimLost = () => {
      if (!wakeClaimActive || wakeClaimAbortController.signal.aborted) {
        throw new ProjectionWakeIntentClaimLostError(intent.wakeIntentId);
      }
    };
    const renewWakeClaim = async () => {
      throwIfWakeClaimLost();
      const renewed = await options.workSignalStore.renewProjectionWakeIntent({
        wakeIntentId: intent.wakeIntentId,
        claimOwnerId: requireClaimOwnerId(intent),
        claimFencingToken: intent.claimFencingToken!,
        claimTtlMs,
      });
      if (!renewed) {
        wakeClaimActive = false;
        wakeClaimAbortController.abort();
        throw new ProjectionWakeIntentClaimLostError(intent.wakeIntentId);
      }
    };
    const wakeClaimRenewIntervalMs = Math.max(1_000, Math.min(leaseRenewIntervalMs, Math.floor(claimTtlMs / 3)));
    const wakeClaimRenewalTimer = setInterval(() => {
      if (wakeClaimRenewalStopped || wakeClaimRenewalInFlight) {
        return;
      }
      wakeClaimRenewalInFlight = true;
      void renewWakeClaim()
        .catch(() => {
          wakeClaimActive = false;
          wakeClaimAbortController.abort();
        })
        .finally(() => {
          wakeClaimRenewalInFlight = false;
        });
    }, wakeClaimRenewIntervalMs);
    wakeClaimRenewalTimer.unref?.();

    try {
      runOutcome = await tryRunWithRenewedLease(
        options.controlPlane,
        {
          leaseName: createProjectionGroupRunnerLeaseName(entry.group),
          ownerId: requireClaimOwnerId(intent),
          ttlMs: leaseTtlMs,
          renewIntervalMs: leaseRenewIntervalMs,
          idleInTransactionSessionTimeoutMs,
          statementTimeoutMs,
          metadata: {
            wakeIntentId: intent.wakeIntentId,
            wakeOrigin: intent.origin,
            priorityLane: intent.priorityLane,
          },
        },
        async (runContext) => {
          const runAndParentSignal = mergeAbortSignals(runContext.signal, context?.signal);
          const wakeRunContext: ProjectionRunContext = {
            ...runContext,
            signal: mergeAbortSignals(runAndParentSignal, wakeClaimAbortController.signal),
            throwIfLeaseLost: () => {
              runContext.throwIfLeaseLost?.();
              if (context?.signal?.aborted) {
                throw new Error("Projection wake scheduler pass is stopping.");
              }
              throwIfWakeClaimLost();
            },
          };

          // Drain toward the claimed required position inside one claim so a
          // multi-batch backlog does not burn one claim cycle per batch.
          for (let runs = 0; runs < maxRunsPerClaim; runs += 1) {
            wakeRunContext.throwIfLeaseLost?.();
            await entry.runner.runOnce(wakeRunContext);
            const status = subscription.getStatus();
            const position = BigInt(status.lastGlobalPosition);
            const progressed = position > checkpointPosition;
            checkpointPosition = position;
            blockedStreamCount = status.blockedStreamCount;
            poisonEventCount = status.poisonEventCount;
            if (position >= requiredPosition || !progressed) {
              return;
            }
          }
        },
      );
    } catch (error) {
      if (error instanceof ProjectionWakeIntentClaimLostError) {
        options.observer?.wakeIntentClaimLost?.(event);
        return "claim-lost";
      }

      if (error instanceof ProjectionGroupRevisionStaleError) {
        // A pending revision rebuild belongs to the polling/operations paths;
        // wake runs must never reset projection state.
        await failIntent(intent, revisionStaleRetryMs, {
          reason: "projection-revision-rebuilding",
          workerId: options.workerId,
        });
        options.observer?.wakeIntentDeferred?.({ ...event, retryAfterMs: revisionStaleRetryMs });
        return "deferred";
      }

      const retryAfterMs = computeRetryBackoffMs(intent.attemptCount);
      await failIntent(intent, retryAfterMs, {
        reason: "projection-run-failed",
        message: error instanceof Error ? error.message : String(error),
        workerId: options.workerId,
      });
      options.observer?.wakeIntentRunFailed?.({ ...event, retryAfterMs, error });
      if (intent.attemptCount === maxAttempts) {
        options.observer?.wakeIntentAttemptsExhausted?.(event);
      }
      return "run-failed";
    } finally {
      wakeClaimRenewalStopped = true;
      clearInterval(wakeClaimRenewalTimer);
      context?.signal?.removeEventListener("abort", abortFromParent);
      wakeClaimAbortController.abort();
    }

    if (!runOutcome.acquired) {
      // The lease holder may have advanced the checkpoint concurrently.
      const statusAfter = await subscription.refreshStatus();
      checkpointPosition = BigInt(statusAfter.lastGlobalPosition);
    }

    if (checkpointPosition >= requiredPosition) {
      return completeIntentAndRecordReadiness(
        intent,
        event,
        checkpointPosition,
        runOutcome.acquired ? "ran" : "already-satisfied",
        claimedAtMs,
      );
    }

    if (!runOutcome.acquired) {
      await deferIntent(intent, deferredRetryMs, {
        reason: "projection-group-lease-busy",
        workerId: options.workerId,
      });
      options.observer?.wakeIntentDeferred?.({ ...event, retryAfterMs: deferredRetryMs });
      return "deferred";
    }

    const madeProgress = checkpointPosition > positionBefore;
    const retryAfterMs = madeProgress ? deferredRetryMs : computeRetryBackoffMs(intent.attemptCount);
    await failIntent(intent, retryAfterMs, {
      reason: madeProgress ? "checkpoint-progressing" : "checkpoint-not-ready",
      checkpointPosition: checkpointPosition.toString(),
      requiredPosition: requiredPosition.toString(),
      blockedStreamCount,
      poisonEventCount,
      workerId: options.workerId,
    });
    options.observer?.wakeIntentNotReady?.({ ...event, retryAfterMs });
    if (!madeProgress && intent.attemptCount === maxAttempts) {
      options.observer?.wakeIntentAttemptsExhausted?.(event);
    }
    return "not-ready";
  };

  return lanes.flatMap((laneConfig) => {
    const runnerCount = Math.max(1, Math.floor(laneConfig.runnerCount));
    return Array.from({ length: runnerCount }, (_, index): WorkerRunner => {
      // Lane runner loop leases are platform-wide single flight per lane
      // instance name; scale lane throughput with runnerCount, not worker
      // instance count.
      const laneRunnerName = `${PROJECTION_WAKE_SCHEDULER_RUNNER_PREFIX}.${laneConfig.lane}.lane-${index + 1}`;
      let claimedWakeIntentLastRun = false;
      return {
        name: laneRunnerName,
        kind: "job",
        // Keep `name` stable for status/metrics continuity, but scope the
        // single-flight lease to this worker's hosted-context cohort so a lane
        // held by a worker that cannot claim a given target context never
        // starves that context's intents platform-wide.
        leaseName: `job:${laneRunnerName}@${hostedContextCohortToken}`,
        // Hot-lane runners are the runner loop's reserved-capacity class so
        // critical read-after-write wakes (checkout, payment-start, proof)
        // always find reserved wake-loop capacity even while standard/bulk
        // passes saturate the shared slots.
        reservedCapacity: laneConfig.lane === "hot",
        rescheduleOnCompletion: () => claimedWakeIntentLastRun,
        runOnce: async (context) => {
          let processed = 0;
          claimedWakeIntentLastRun = false;

          for (let claims = 0; claims < maxClaimsPerRun; claims += 1) {
            context?.throwIfLeaseLost?.();
            if (context?.signal?.aborted) {
              break;
            }

            const intent = await options.workSignalStore.claimNextProjectionWakeIntent({
              claimOwnerId: `${options.workerId}:${laneRunnerName}`,
              claimTtlMs,
              maxAttempts,
              priorityLanes: [laneConfig.lane],
              targetContextNames: hostedTargetContextNames,
            });
            if (!intent) {
              break;
            }
            claimedWakeIntentLastRun = true;

            options.observer?.wakeIntentClaimed?.(
              createLifecycleEvent(options.workerId, laneRunnerName, intent, now()),
            );

            const outcome = await processClaimedWakeIntent(intent, laneRunnerName, context);
            if (outcome === "completed" || outcome === "already-satisfied") {
              processed += 1;
            }
            if (outcome === "run-failed") {
              // The intent retry is durably recorded; end the pass so a failing
              // target cannot monopolize the lane within one pass.
              break;
            }
          }

          return {
            processed,
            lastGlobalPosition: ZERO_GLOBAL_POSITION,
            state: processed > 0 ? "running" : "caught-up",
          } satisfies ProjectorRunResult;
        },
      };
    });
  });
}

export function startProjectionWakePushDispatcher(
  input: ProjectionWakePushDispatcherInput,
): ProjectionWakePushDispatcher {
  const waitTimeoutMs = Math.max(
    100,
    Math.floor(input.waitTimeoutMs ?? DEFAULT_PROJECTION_WAKE_PUSH_DISPATCH_WAIT_TIMEOUT_MS),
  );
  const targetContextNames =
    input.targetContextNames && input.targetContextNames.length > 0 ? new Set(input.targetContextNames) : null;
  const abortController = new AbortController();
  const abortFromInput = () => abortController.abort();
  if (input.signal?.aborted) {
    abortController.abort();
  } else {
    input.signal?.addEventListener("abort", abortFromInput, { once: true });
  }

  const done = (async () => {
    try {
      while (!abortController.signal.aborted) {
        const result = await input.waiter.wait({
          timeoutMs: waitTimeoutMs,
          signal: abortController.signal,
          matches: (notification) => notificationMatchesProjectionWakeIntent(notification, targetContextNames),
        });
        input.observer?.waitEnded?.({ result });
        if (result !== "notified" || abortController.signal.aborted) {
          continue;
        }

        input.nudge();
        input.observer?.nudgeScheduled?.({ targetContextName: null });
      }
    } finally {
      input.signal?.removeEventListener("abort", abortFromInput);
      await input.waiter.stop();
    }
  })();

  return {
    done,
    stop: async () => {
      abortController.abort();
      await input.waiter.stop();
      await done;
    },
  };
}

export function startPostgresProjectionWakePushDispatcher(
  input: PostgresProjectionWakePushDispatcherInput,
): ProjectionWakePushDispatcher {
  return startProjectionWakePushDispatcher({
    ...input,
    waiter: createPostgresWorkSignalWaiter(input.listenerPool, {
      channel: PROJECTION_WAKE_INTENT_WORK_SIGNAL_CHANNEL,
      listenRetryCooldownMs: input.listenRetryCooldownMs,
      observer: input.listenerObserver,
    }),
  });
}

export function createWorkSignalCleanupRunner(
  input: Readonly<{
    controlPlane: Pick<PlatformControlPlane, "claimScheduledRunner" | "recordScheduledRunnerCompleted">;
    workSignalStore: Pick<PostgresWorkSignalStore, "cleanupExpiredWorkSignals">;
    intervalMs?: number;
    limit?: number;
    observer?: Pick<ProjectionWakeSchedulerObserver, "workSignalCleanupCompleted">;
  }>,
): WorkerRunner {
  const intervalMs = Math.max(1_000, Math.floor(input.intervalMs ?? DEFAULT_WORK_SIGNAL_CLEANUP_INTERVAL_MS));

  return {
    name: WORK_SIGNAL_CLEANUP_RUNNER_NAME,
    kind: "job",
    runOnce: async () => {
      const claimed = await input.controlPlane.claimScheduledRunner({
        runnerName: WORK_SIGNAL_CLEANUP_RUNNER_NAME,
        intervalMs,
      });
      if (!claimed) {
        return {
          processed: 0,
          lastGlobalPosition: ZERO_GLOBAL_POSITION,
          state: "caught-up",
        };
      }

      const result = await input.workSignalStore.cleanupExpiredWorkSignals({ limit: input.limit });
      await input.controlPlane.recordScheduledRunnerCompleted({ runnerName: WORK_SIGNAL_CLEANUP_RUNNER_NAME });
      input.observer?.workSignalCleanupCompleted?.({ result });

      return {
        processed:
          result.expiredWakeIntents +
          result.prunedWakeIntents +
          result.prunedCheckpointReadiness +
          result.prunedCheckpointWaiters,
        lastGlobalPosition: ZERO_GLOBAL_POSITION,
        state: "caught-up",
      };
    },
  };
}

class ProjectionWakeIntentClaimLostError extends Error {
  public constructor(wakeIntentId: string) {
    super(`Projection wake intent '${wakeIntentId}' claim was lost.`);
    this.name = "ProjectionWakeIntentClaimLostError";
  }
}

function createProjectionGroupKey(targetContextName: string, projectionName: string): string {
  return `${targetContextName}.${projectionName}`;
}

/**
 * A stable, length-bounded token identifying a worker's hosted-context claim
 * scope. Workers with an identical (sorted, deduped) hosted-target-context set
 * produce the same token and therefore share one single-flight lane lease
 * (preserving the platform-wide wake connection budget within the cohort);
 * workers with a different set produce a different token and get their own
 * lease, so no hosted context can be starved by a lane lease held by a worker
 * that does not host it. Exported for the starvation regression test.
 */
export function createHostedContextCohortToken(hostedTargetContextNames: readonly string[]): string {
  const normalized = [...new Set(hostedTargetContextNames)].sort();
  const digest = createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 16);
  return `ctx-${digest}`;
}

function notificationMatchesProjectionWakeIntent(
  notification: PostgresWorkSignalNotification,
  targetContextNames: ReadonlySet<string> | null,
): boolean {
  if (notification.envelope?.kind !== "projection.wake-intent") {
    return false;
  }
  if (!targetContextNames) {
    return true;
  }

  const payload = notification.envelope.payload as Partial<ProjectionWakeIntentWorkSignalPayload>;
  return typeof payload.targetContextName === "string" && targetContextNames.has(payload.targetContextName);
}

function buildProjectionGroupIndex(
  projectionGroups: readonly ContextProjectionGroup[],
): ReadonlyMap<string, ProjectionGroupIndexEntry> {
  const index = new Map<string, ProjectionGroupIndexEntry>();
  for (const group of projectionGroups) {
    index.set(createProjectionGroupKey(group.targetContextName, group.projectionName), {
      group,
      runner: createProjectionGroupWorkerRunner(group, { revisionStaleBehavior: "reject" }),
      subscriptionsByCheckpointKey: new Map(group.subscriptionRunners.map((runner) => [runner.checkpointKey, runner])),
    });
  }

  return index;
}

function createLifecycleEvent(
  workerId: string,
  laneRunnerName: string,
  intent: ProjectionWakeIntentRecord,
  at: Date,
): ProjectionWakeIntentLifecycleEvent {
  return {
    workerId,
    laneRunnerName,
    wakeIntentId: intent.wakeIntentId,
    priorityLane: intent.priorityLane,
    origin: intent.origin,
    sourceContextName: intent.sourceContextName,
    targetContextName: intent.targetContextName,
    projectionName: intent.projectionName,
    checkpointKey: intent.checkpointKey,
    requiredPosition: (intent.claimedRequiredPosition ?? intent.requiredPosition).toString(),
    attemptCount: intent.attemptCount,
    queueAgeMs: Math.max(0, at.getTime() - intent.createdAt.getTime()),
  };
}

function requireClaimOwnerId(intent: ProjectionWakeIntentRecord): string {
  if (!intent.claimOwnerId) {
    throw new Error(`Projection wake intent '${intent.wakeIntentId}' is missing its claim owner.`);
  }

  return intent.claimOwnerId;
}

function mergeAbortSignals(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([left, right]);
  }

  const controller = new AbortController();
  if (left.aborted || right.aborted) {
    controller.abort();
    return controller.signal;
  }

  const abort = () => controller.abort();
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
