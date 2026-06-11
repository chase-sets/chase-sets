import {
  compactRuntimeSubscriptionLedgers,
  createProjectionAwarePool,
  cleanupRuntimeProjectionGenerations,
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  resetProjectionGroup,
  retryProjectionBlockedStream,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  sortSubscriptionRunners,
  type ContextProjectionGroup,
  type ContextProjectionGroupStatus,
  type ContextSubscriptionRunner,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import type { BcApiModule, BcHostPort } from "@chase-sets/bounded-context-module";
import type { ProjectionRunContext, ProjectorRunResult } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PlatformControlPlane, PlatformLease, ProjectionOperationRecord } from "./control-plane";
import type { PostgresWorkSignalStore } from "./work-signal-store";

export type WorkerHostName = "platform-worker" | "admin-support-worker";

export type WorkerContextManifest = Readonly<{
  contextName: string;
  runtimeDeployables?: readonly string[];
  hostPorts?: readonly BcHostPort[];
}>;

export type WorkerContextRegistryEntry = Readonly<{
  contextName: string;
  packageName: string;
  manifest: WorkerContextManifest;
  module: BcApiModule;
}>;

export type WorkerContextRegistry = readonly WorkerContextRegistryEntry[];
export type WorkerHostContextName<TRegistry extends WorkerContextRegistry = WorkerContextRegistry> =
  TRegistry[number]["contextName"];

export type WorkerHostRuntime = Readonly<{
  mountedContexts: readonly MountedContextRuntimeEntry[];
  services: Readonly<Record<string, unknown>>;
  projectionGroups: ReturnType<typeof resolveModuleProjectionGroups>;
  subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;
}>;

export type WorkerRunner = Readonly<{
  name: string;
  kind: "projector" | "projection-group" | "subscription" | "job";
  runOnce: (context?: ProjectionRunContext) => Promise<ProjectorRunResult>;
  priority?: () => bigint | number;
  projectionStatusSnapshot?: () => ContextProjectionGroupStatus;
}>;

export type WorkerRunnerLoop = Readonly<{
  start: () => void;
  stop: () => Promise<void>;
  status: () => Readonly<{
    workerId: string;
    activeRunnerCount: number;
    leaseMissCount: number;
    stopped: boolean;
  }>;
}>;

export type WorkerRuntimeObserver = Readonly<{
  leaseMissed?: (event: WorkerLeaseEvent) => void;
  leaseRenewFailed?: (event: WorkerLeaseEvent & Readonly<{ error?: unknown }>) => void;
  runnerCompleted?: (event: WorkerRunnerCompletedEvent) => void;
  runnerFailed?: (event: WorkerRunnerFailedEvent) => void;
  projectionOperationStarted?: (event: WorkerProjectionOperationEvent) => void;
  projectionOperationCompleted?: (event: WorkerProjectionOperationEvent) => void;
  projectionOperationFailed?: (event: WorkerProjectionOperationEvent & Readonly<{ error: unknown }>) => void;
}>;

export type WorkerLeaseEvent = Readonly<{
  workerId: string;
  runnerName: string;
  runnerKind: WorkerRunner["kind"];
  leaseName: string;
  ownerId?: string;
  fencingToken?: string;
}>;

export type WorkerRunnerCompletedEvent = WorkerLeaseEvent &
  Readonly<{
    processed: number;
    state?: ProjectorRunResult["state"];
    operationId?: string;
  }>;

export type WorkerRunnerFailedEvent = WorkerLeaseEvent &
  Readonly<{
    error: unknown;
    operationId?: string;
  }>;

export type WorkerProjectionOperationEvent = Readonly<{
  operationId: string;
  operationKind: ProjectionOperationRecord["operationKind"];
  operationState: ProjectionOperationRecord["state"];
  workerId: string;
  ownerId: string;
  fencingToken: string;
  contextName: string;
  projectionName: string | null;
  projectionKey: string | null;
  streamId: string | null;
}>;

export type DurableJobLaneRunContext = Readonly<{
  workflowName: string;
  laneName: string;
  laneIndex: number;
  laneCount: number;
  runnerContext?: ProjectionRunContext;
}>;

type WorkerRunnerLoopOptions = Readonly<{
  workerId: string;
  controlPlane: PlatformControlPlane;
  runners: readonly WorkerRunner[];
  maxConcurrentRunners: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  pollIntervalMs: number;
  failureBackoffBaseMs?: number;
  failureBackoffMaxMs?: number;
  observer?: WorkerRuntimeObserver;
  onError?: (error: unknown, runner: WorkerRunner) => void;
}>;

export function createDurableJobLaneRunners(input: {
  workflowName: string;
  laneCount: number;
  runLane: (context: DurableJobLaneRunContext) => Promise<ProjectorRunResult>;
  priority?: () => bigint | number;
}): readonly WorkerRunner[] {
  const laneCount = Math.max(1, Math.floor(input.laneCount));
  return Array.from({ length: laneCount }, (_, index): WorkerRunner => {
    const laneIndex = index + 1;
    const laneName = `job:${input.workflowName}.lane-${laneIndex}`;
    return {
      name: laneName,
      kind: "job",
      priority: input.priority,
      runOnce: (runnerContext) =>
        input.runLane({
          workflowName: input.workflowName,
          laneName,
          laneIndex,
          laneCount,
          runnerContext,
        }),
    };
  });
}

export function getWorkerHostEntries<TRegistry extends WorkerContextRegistry>(
  registry: TRegistry,
  hostName: WorkerHostName,
): readonly WorkerContextRegistryEntry[] {
  return registry.filter((entry) => entry.manifest.runtimeDeployables?.includes(hostName));
}

export function getWorkerHostContextNames<TRegistry extends WorkerContextRegistry>(
  registry: TRegistry,
  hostName: WorkerHostName,
): readonly WorkerHostContextName<TRegistry>[] {
  return getWorkerHostEntries(registry, hostName).map((entry) => entry.contextName as WorkerHostContextName<TRegistry>);
}

export function createWorkerHost(
  registry: WorkerContextRegistry,
  hostName: WorkerHostName,
  options: Readonly<{
    pools: Readonly<Record<string, PgTransactionalPool>>;
    hostPorts?: Readonly<Record<string, unknown>>;
  }>,
): WorkerHostRuntime {
  const entries = getWorkerHostEntries(registry, hostName);
  const services = Object.fromEntries(
    entries.map((entry) => {
      const pool = options.pools[entry.contextName];
      if (!pool) {
        throw new Error(`Worker host '${hostName}' is missing a pool for context '${entry.contextName}'.`);
      }

      return [
        entry.contextName,
        entry.module.createServices(
          createProjectionAwarePool(pool),
          getHostPortsForContext(entry.manifest, options.hostPorts ?? {}) as never,
        ),
      ];
    }),
  );

  const mountedContexts = entries.map((entry) => {
    const pool = options.pools[entry.contextName];
    const contextServices = services[entry.contextName];

    return {
      contextName: entry.contextName,
      mountRole: "active" as const,
      module: entry.module,
      services: contextServices,
      pool,
      projectionHandlerSets: entry.module.projectionHandlerSets?.(contextServices as never) ?? [],
    };
  });
  const subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
  const projectionGroups = resolveModuleProjectionGroups(mountedContexts, subscriptionRunners);

  return {
    mountedContexts,
    services,
    projectionGroups,
    subscriptionRunners,
  };
}

export function collectWorkerRunners(
  runtime: WorkerHostRuntime,
  options: Readonly<{
    controlPlane?: PlatformControlPlane;
    projectionOperationClaimTtlMs?: number;
    projectionOperationLeaseTtlMs?: number;
    projectionOperationLeaseRenewIntervalMs?: number;
    projectionOperationStatementTimeoutMs?: number;
    projectionOperationCancelPollIntervalMs?: number;
    workSignalStore?: Pick<PostgresWorkSignalStore, "recordCheckpointReady" | "clearCheckpointReadiness">;
    observer?: WorkerRuntimeObserver;
  }> = {},
): readonly WorkerRunner[] {
  const onCheckpointsAdvanced = options.workSignalStore
    ? createCheckpointReadinessRecorder(options.workSignalStore)
    : undefined;
  const onCheckpointsReset = options.workSignalStore
    ? async (checkpointKeys: readonly string[]) => {
        await options.workSignalStore?.clearCheckpointReadiness({ checkpointKeys });
      }
    : undefined;
  const runners = [
    ...runtime.projectionGroups.map((group) =>
      createProjectionGroupWorkerRunner(group, { onCheckpointsAdvanced, onCheckpointsReset }),
    ),
    createSubscriptionLedgerCompactionRunner(runtime),
    createProjectionGenerationRetentionRunner(runtime),
  ];

  return options.controlPlane
    ? [
        ...runners,
        createProjectionOperationWorkerRunner(runtime, {
          controlPlane: options.controlPlane,
          claimTtlMs: options.projectionOperationClaimTtlMs ?? 120_000,
          leaseTtlMs: options.projectionOperationLeaseTtlMs ?? 120_000,
          leaseRenewIntervalMs: options.projectionOperationLeaseRenewIntervalMs ?? 30_000,
          statementTimeoutMs: options.projectionOperationStatementTimeoutMs ?? 30_000,
          cancelPollIntervalMs: options.projectionOperationCancelPollIntervalMs ?? 5_000,
          onCheckpointsReset,
          observer: options.observer,
        }),
      ]
    : runners;
}

export function createWorkerRunnerLoop(options: WorkerRunnerLoopOptions): WorkerRunnerLoop {
  const active = new Set<Promise<void>>();
  const activeAbortControllers = new Map<Promise<void>, AbortController>();
  const activeRunnerNames = new Set<string>();
  const failedRunnerBackoffs = new Map<string, Readonly<{ attempt: number; eligibleAt: number }>>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunnerIndex = 0;
  let leaseMissCount = 0;
  const failureBackoffBaseMs = Math.max(0, Math.floor(options.failureBackoffBaseMs ?? options.pollIntervalMs * 5));
  const failureBackoffMaxMs = Math.max(failureBackoffBaseMs, Math.floor(options.failureBackoffMaxMs ?? 30_000));

  const schedule = () => {
    if (stopped) {
      return;
    }

    const now = Date.now();
    for (
      let attempts = 0;
      attempts < options.runners.length && active.size < options.maxConcurrentRunners;
      attempts += 1
    ) {
      const selection = selectNextRunner(
        options.runners,
        activeRunnerNames,
        failedRunnerBackoffs,
        nextRunnerIndex,
        now,
      );
      if (!selection) {
        break;
      }
      const { runner, index } = selection;
      nextRunnerIndex = (index + 1) % options.runners.length;

      const runAbortController = new AbortController();
      const promise = runLeasedRunner(options, runner, runAbortController.signal)
        .then((leaseAcquired) => {
          if (!leaseAcquired) {
            leaseMissCount += 1;
            return;
          }
          failedRunnerBackoffs.delete(runner.name);
        })
        .catch((error) => {
          const previous = failedRunnerBackoffs.get(runner.name);
          const attempt = (previous?.attempt ?? 0) + 1;
          const backoffMs =
            failureBackoffBaseMs <= 0
              ? 0
              : Math.min(failureBackoffMaxMs, failureBackoffBaseMs * 2 ** Math.min(attempt - 1, 10));
          failedRunnerBackoffs.set(runner.name, {
            attempt,
            eligibleAt: Date.now() + backoffMs,
          });
          options.onError?.(error, runner);
        })
        .finally(() => {
          active.delete(promise);
          activeAbortControllers.delete(promise);
          activeRunnerNames.delete(runner.name);
        });
      active.add(promise);
      activeAbortControllers.set(promise, runAbortController);
      activeRunnerNames.add(runner.name);
    }

    timer = setTimeout(schedule, options.pollIntervalMs);
    timer.unref?.();
  };

  return {
    start: () => schedule(),
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      for (const abortController of activeAbortControllers.values()) {
        abortController.abort();
      }
      await Promise.allSettled([...active]);
    },
    status: () => ({
      workerId: options.workerId,
      activeRunnerCount: active.size,
      leaseMissCount,
      stopped,
    }),
  };
}

function selectNextRunner(
  runners: readonly WorkerRunner[],
  activeRunnerNames: ReadonlySet<string>,
  failedRunnerBackoffs: ReadonlyMap<string, Readonly<{ eligibleAt: number }>>,
  startIndex: number,
  now: number,
): Readonly<{ runner: WorkerRunner; index: number }> | null {
  let fallback: Readonly<{ runner: WorkerRunner; index: number }> | null = null;

  for (let offset = 0; offset < runners.length; offset += 1) {
    const index = (startIndex + offset) % runners.length;
    const runner = runners[index];
    if (activeRunnerNames.has(runner.name)) {
      continue;
    }
    const failedBackoff = failedRunnerBackoffs.get(runner.name);
    if (failedBackoff && failedBackoff.eligibleAt > now) {
      continue;
    }

    const priority = resolveRunnerPriority(runner);
    if (priority > 0n) {
      return { runner, index };
    }

    if (!fallback) {
      fallback = { runner, index };
    }
  }

  return fallback;
}

function resolveRunnerPriority(runner: WorkerRunner): bigint {
  try {
    const priority = runner.priority?.() ?? 0;
    return BigInt(priority);
  } catch {
    return 0n;
  }
}

async function runLeasedRunner(
  options: WorkerRunnerLoopOptions,
  runner: WorkerRunner,
  runSignal?: AbortSignal,
): Promise<boolean> {
  if (runSignal?.aborted) {
    return true;
  }

  const leaseName = createWorkerRunnerLeaseName(runner);
  const lease = await options.controlPlane.acquireLease({
    leaseName,
    ownerId: options.workerId,
    ttlMs: options.leaseTtlMs,
    metadata: { runnerKind: runner.kind },
  });
  if (!lease) {
    options.observer?.leaseMissed?.({
      workerId: options.workerId,
      runnerName: runner.name,
      runnerKind: runner.kind,
      leaseName,
    });
    return false;
  }

  let leaseActive = true;
  const abortController = new AbortController();
  const abortForStop = () => abortController.abort();
  if (runSignal?.aborted) {
    abortController.abort();
  } else {
    runSignal?.addEventListener("abort", abortForStop, { once: true });
  }
  const stoppedCooperatively = () => runSignal?.aborted === true && abortController.signal.aborted;
  const throwIfLeaseLost = () => {
    if (!leaseActive || abortController.signal.aborted) {
      throw new Error(`Lost lease '${lease.leaseName}'.`);
    }
  };
  const renewalTimer = setInterval(() => {
    void options.controlPlane
      .renewLease(lease, options.leaseTtlMs)
      .then((renewed) => {
        leaseActive = leaseActive && renewed;
        if (!renewed) {
          options.observer?.leaseRenewFailed?.(leaseEvent(options.workerId, runner, lease));
          abortController.abort();
        }
      })
      .catch((error: unknown) => {
        leaseActive = false;
        options.observer?.leaseRenewFailed?.({ ...leaseEvent(options.workerId, runner, lease), error });
        abortController.abort();
      });
  }, options.leaseRenewIntervalMs);
  renewalTimer.unref?.();

  try {
    await options.controlPlane.recordRunnerStatus({
      runnerName: runner.name,
      runnerKind: runner.kind,
      state: "running",
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
    });

    throwIfLeaseLost();

    const runnerContext: ProjectionRunContext = {
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      signal: abortController.signal,
      throwIfLeaseLost,
    };
    const result = await runner.runOnce(runnerContext);
    throwIfLeaseLost();
    options.observer?.runnerCompleted?.({
      ...leaseEvent(options.workerId, runner, lease),
      processed: result.processed,
      state: result.state,
      operationId: runnerContext.operationId,
    });
    const state = result.state === "degraded" ? "degraded" : result.processed > 0 ? "running" : "caught-up";

    throwIfLeaseLost();
    await options.controlPlane.recordRunnerStatus({
      runnerName: runner.name,
      runnerKind: runner.kind,
      state,
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      lastProcessed: result.processed,
      lastError:
        state === "degraded"
          ? `Projection has ${result.blockedStreams ?? 0} blocked stream(s) and ${result.poisonEvents ?? 0} poison event(s).`
          : null,
    });

    const projectionStatusSnapshot = runner.projectionStatusSnapshot?.();
    if (projectionStatusSnapshot) {
      throwIfLeaseLost();
      await options.controlPlane.recordProjectionStatusSnapshot({
        projectionKey: `${projectionStatusSnapshot.targetContextName}.${projectionStatusSnapshot.projectionName}`,
        targetContextName: projectionStatusSnapshot.targetContextName,
        projectionName: projectionStatusSnapshot.projectionName,
        runnerName: runner.name,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        status: projectionStatusSnapshot as unknown as Record<string, unknown>,
      });
    }
  } catch (error) {
    if (stoppedCooperatively()) {
      return true;
    }
    options.observer?.runnerFailed?.({
      ...leaseEvent(options.workerId, runner, lease),
      error,
    });
    if (leaseActive && !abortController.signal.aborted) {
      await options.controlPlane.recordRunnerStatus({
        runnerName: runner.name,
        runnerKind: runner.kind,
        state: "error",
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    runSignal?.removeEventListener("abort", abortForStop);
    clearInterval(renewalTimer);
    await options.controlPlane.releaseLease(lease);
  }

  return true;
}

export function createWorkerRunnerLeaseName(runner: Pick<WorkerRunner, "kind" | "name">): string {
  return `${runner.kind}:${runner.name}`;
}

export function createProjectionGroupRunnerName(
  group: Pick<ContextProjectionGroup, "targetContextName" | "projectionName">,
) {
  return `${group.targetContextName}.${group.projectionName}`;
}

export function createProjectionGroupRunnerLeaseName(
  group: Pick<ContextProjectionGroup, "targetContextName" | "projectionName">,
): string {
  return createWorkerRunnerLeaseName({
    kind: "projection-group",
    name: createProjectionGroupRunnerName(group),
  });
}

export class ProjectionGroupRevisionStaleError extends Error {
  constructor(group: Pick<ContextProjectionGroup, "targetContextName" | "projectionName">) {
    super(
      `Projection group '${group.targetContextName}.${group.projectionName}' has a stale revision pending rebuild.`,
    );
    this.name = "ProjectionGroupRevisionStaleError";
  }
}

export function createCheckpointReadinessRecorder(
  workSignalStore: Pick<PostgresWorkSignalStore, "recordCheckpointReady">,
): (status: ContextProjectionGroupStatus, previousStatus?: ContextProjectionGroupStatus) => Promise<void> {
  return async (status, previousStatus) => {
    const previousPositions = new Map(
      (previousStatus?.subscriptions ?? []).map((subscription) => [
        subscription.checkpointKey,
        BigInt(subscription.lastGlobalPosition),
      ]),
    );

    for (const subscription of status.subscriptions) {
      const previousPosition = previousPositions.get(subscription.checkpointKey);
      if (previousPosition !== undefined && BigInt(subscription.lastGlobalPosition) <= previousPosition) {
        continue;
      }

      await workSignalStore.recordCheckpointReady({
        checkpointKey: subscription.checkpointKey,
        sourceContextName: subscription.sourceContextName,
        targetContextName: subscription.targetContextName,
        projectionName: subscription.projectionName,
        readyPosition: subscription.lastGlobalPosition,
        metadata: { recordedBy: "projection-poll" },
      });
    }
  };
}

export function createProjectionGroupWorkerRunner(
  group: ContextProjectionGroup,
  options: Readonly<{
    revisionStaleBehavior?: "reset" | "reject";
    onCheckpointsAdvanced?: (
      status: ContextProjectionGroupStatus,
      previousStatus?: ContextProjectionGroupStatus,
    ) => Promise<void>;
    onCheckpointsReset?: (checkpointKeys: readonly string[]) => Promise<void>;
  }> = {},
): WorkerRunner {
  const revisionStaleBehavior = options.revisionStaleBehavior ?? "reset";
  let rebuildingRevision: number | null = null;

  return {
    name: createProjectionGroupRunnerName(group),
    kind: "projection-group",
    priority: () => BigInt(group.getStatus().outstandingEventCount),
    projectionStatusSnapshot: () => group.getStatus(),
    runOnce: async (context) => {
      try {
        context?.throwIfLeaseLost?.();
        const status = await group.refreshStatus();
        if (status.revisionStale && revisionStaleBehavior === "reject") {
          throw new ProjectionGroupRevisionStaleError(group);
        }
        if (status.revisionStale && rebuildingRevision !== group.projectionRevision) {
          context?.throwIfLeaseLost?.();
          await resetProjectionGroup(group, context);
          rebuildingRevision = group.projectionRevision;
          if (options.onCheckpointsReset) {
            try {
              await options.onCheckpointsReset(group.subscriptionRunners.map((runner) => runner.checkpointKey));
            } catch {
              // Readiness clearing is best-effort; the bounded readiness TTL
              // still reaps stale rows.
            }
          }
        }

        let processed = 0;
        let lastGlobalPosition = ZERO_GLOBAL_POSITION;
        let blockedStreams = 0;
        let poisonEvents = 0;

        for (const result of await runSubscriptionRunnersByOrder(group.subscriptionRunners, context)) {
          processed += result.processed;
          lastGlobalPosition = maxGlobalPosition(lastGlobalPosition, result.lastGlobalPosition);
          blockedStreams += result.blockedStreams ?? 0;
          poisonEvents += result.poisonEvents ?? 0;
        }

        if (processed === 0 && blockedStreams === 0) {
          context?.throwIfLeaseLost?.();
          await group.markRevisionSynced();
          rebuildingRevision = null;
        }

        if (processed > 0 && options.onCheckpointsAdvanced) {
          try {
            await options.onCheckpointsAdvanced(group.getStatus(), status);
          } catch {
            // Readiness recording is best-effort and must never fail the run.
          }
        }

        return {
          processed,
          lastGlobalPosition,
          state: blockedStreams > 0 ? "degraded" : processed > 0 ? "running" : "caught-up",
          blockedStreams,
          poisonEvents,
        };
      } catch (error) {
        rebuildingRevision = null;
        throw error;
      }
    },
  };
}

function createProjectionOperationWorkerRunner(
  runtime: WorkerHostRuntime,
  options: Readonly<{
    controlPlane: PlatformControlPlane;
    claimTtlMs: number;
    leaseTtlMs: number;
    leaseRenewIntervalMs: number;
    statementTimeoutMs: number;
    cancelPollIntervalMs: number;
    onCheckpointsReset?: (checkpointKeys: readonly string[]) => Promise<void>;
    observer?: WorkerRuntimeObserver;
  }>,
): WorkerRunner {
  return {
    name: "projection-operations",
    kind: "job",
    priority: () => 0,
    runOnce: async (context) => {
      const ownerId = context?.ownerId ?? "projection-operation-worker";
      const operation = await options.controlPlane.claimProjectionOperation({
        ownerId,
        claimTtlMs: options.claimTtlMs,
      });

      if (!operation) {
        return {
          processed: 0,
          lastGlobalPosition: ZERO_GLOBAL_POSITION,
          state: "caught-up",
        };
      }

      if (!operation.claimFencingToken) {
        throw new Error(`Projection operation '${operation.operationId}' was claimed without a fencing token.`);
      }

      try {
        options.observer?.projectionOperationStarted?.(
          projectionOperationEvent(operation, ownerId, operation.claimFencingToken),
        );
        const runningProgress = {
          ...operation.progress,
          state: "running",
        };
        await requireProjectionOperationClaim(
          options.controlPlane.recordProjectionOperationProgress({
            operationId: operation.operationId,
            ownerId,
            fencingToken: operation.claimFencingToken,
            claimTtlMs: options.claimTtlMs,
            progress: runningProgress,
          }),
          operation.operationId,
        );
        await runProjectionOperationWithRenewedClaim(runtime, options, operation, ownerId, runningProgress, context);
        await requireProjectionOperationClaim(
          options.controlPlane.completeProjectionOperation({
            operationId: operation.operationId,
            ownerId,
            fencingToken: operation.claimFencingToken,
            result: {
              state: "completed",
            },
          }),
          operation.operationId,
        );
        options.observer?.projectionOperationCompleted?.(
          projectionOperationEvent({ ...operation, state: "succeeded" }, ownerId, operation.claimFencingToken),
        );

        return {
          processed: 1,
          lastGlobalPosition: ZERO_GLOBAL_POSITION,
          state: "running",
        };
      } catch (error) {
        const latestOperation = await options.controlPlane.getProjectionOperation(operation.operationId);
        if (latestOperation?.state === "cancel_requested") {
          await requireProjectionOperationClaim(
            options.controlPlane.completeProjectionOperation({
              operationId: operation.operationId,
              ownerId,
              fencingToken: operation.claimFencingToken,
              result: {
                state: "cancelled",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
            operation.operationId,
          );
          options.observer?.projectionOperationCompleted?.(
            projectionOperationEvent({ ...operation, state: "cancelled" }, ownerId, operation.claimFencingToken),
          );
          return {
            processed: 1,
            lastGlobalPosition: ZERO_GLOBAL_POSITION,
            state: "degraded",
          };
        }

        await requireProjectionOperationClaim(
          options.controlPlane.failProjectionOperation({
            operationId: operation.operationId,
            ownerId,
            fencingToken: operation.claimFencingToken,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
          operation.operationId,
        );
        options.observer?.projectionOperationFailed?.({
          ...projectionOperationEvent({ ...operation, state: "failed" }, ownerId, operation.claimFencingToken),
          error,
        });
        throw error;
      }
    },
  };
}

async function runProjectionOperationWithRenewedClaim(
  runtime: WorkerHostRuntime,
  options: Readonly<{
    controlPlane: PlatformControlPlane;
    claimTtlMs: number;
    leaseTtlMs: number;
    leaseRenewIntervalMs: number;
    statementTimeoutMs: number;
    cancelPollIntervalMs: number;
    onCheckpointsReset?: (checkpointKeys: readonly string[]) => Promise<void>;
  }>,
  operation: ProjectionOperationRecord,
  ownerId: string,
  progress: Record<string, unknown>,
  runnerContext?: ProjectionRunContext,
): Promise<void> {
  const fencingToken = operation.claimFencingToken;
  if (!fencingToken) {
    throw new Error(`Projection operation '${operation.operationId}' is missing its claim fencing token.`);
  }

  let claimActive = true;
  const abortController = new AbortController();
  const abortFromParent = () => {
    claimActive = false;
    abortController.abort();
  };
  runnerContext?.signal?.addEventListener("abort", abortFromParent, { once: true });

  const throwIfOperationClaimLost = () => {
    runnerContext?.throwIfLeaseLost?.();
    if (!claimActive || abortController.signal.aborted) {
      throw new Error(`Projection operation '${operation.operationId}' claim was lost.`);
    }
  };
  const renewOperationClaim = async () => {
    throwIfOperationClaimLost();
    const renewed = await options.controlPlane.recordProjectionOperationProgress({
      operationId: operation.operationId,
      ownerId,
      fencingToken,
      claimTtlMs: options.claimTtlMs,
      progress,
    });
    if (!renewed) {
      claimActive = false;
      abortController.abort();
      throw new Error(`Projection operation '${operation.operationId}' claim was lost.`);
    }
  };

  const renewIntervalMs = Math.max(1_000, Math.min(options.leaseRenewIntervalMs, Math.floor(options.claimTtlMs / 3)));
  let renewalInFlight = false;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight) {
      return;
    }
    renewalInFlight = true;
    void renewOperationClaim()
      .catch(() => {
        claimActive = false;
        abortController.abort();
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, renewIntervalMs);
  renewalTimer.unref?.();

  const operationContext: ProjectionRunContext = {
    ...runnerContext,
    signal: abortController.signal,
    throwIfLeaseLost: throwIfOperationClaimLost,
  };

  try {
    await runProjectionOperation(runtime, options, operation, ownerId, operationContext);
    throwIfOperationClaimLost();
  } finally {
    clearInterval(renewalTimer);
    runnerContext?.signal?.removeEventListener("abort", abortFromParent);
    abortController.abort();
  }
}

async function runProjectionOperation(
  runtime: WorkerHostRuntime,
  options: Readonly<{
    controlPlane: PlatformControlPlane;
    leaseTtlMs: number;
    leaseRenewIntervalMs: number;
    statementTimeoutMs: number;
    cancelPollIntervalMs: number;
    onCheckpointsReset?: (checkpointKeys: readonly string[]) => Promise<void>;
  }>,
  operation: ProjectionOperationRecord,
  ownerId: string,
  runnerContext?: ProjectionRunContext,
): Promise<void> {
  runnerContext?.throwIfLeaseLost?.();

  if (operation.operationKind === "rebuild-projection-group") {
    const projectionName = requireProjectionOperationField(operation, "projectionName");
    await runWithRenewedLease(
      options.controlPlane,
      {
        leaseName: createProjectionGroupRunnerLeaseName({
          targetContextName: operation.contextName,
          projectionName,
        }),
        ownerId,
        ttlMs: options.leaseTtlMs,
        renewIntervalMs: options.leaseRenewIntervalMs,
        statementTimeoutMs: options.statementTimeoutMs,
        shouldAbort: () => shouldAbortProjectionOperation(options.controlPlane, operation.operationId, runnerContext),
        abortPollIntervalMs: options.cancelPollIntervalMs,
        metadata: {
          operationId: operation.operationId,
          operationKind: operation.operationKind,
        },
      },
      async (context) => {
        await clearGroupCheckpointReadiness(runtime, operation.contextName, projectionName, options);
        return rebuildContextProjectionGroup(runtime, operation.contextName, projectionName, context);
      },
    );
    return;
  }

  if (operation.operationKind === "rebuild-context") {
    const groups = runtime.projectionGroups.filter((group) => group.targetContextName === operation.contextName);
    if (groups.length === 0) {
      throw new Error(`Runtime is missing projection groups for context '${operation.contextName}'.`);
    }

    for (const group of groups) {
      runnerContext?.throwIfLeaseLost?.();
      await runWithRenewedLease(
        options.controlPlane,
        {
          leaseName: createProjectionGroupRunnerLeaseName(group),
          ownerId,
          ttlMs: options.leaseTtlMs,
          renewIntervalMs: options.leaseRenewIntervalMs,
          statementTimeoutMs: options.statementTimeoutMs,
          shouldAbort: () => shouldAbortProjectionOperation(options.controlPlane, operation.operationId, runnerContext),
          abortPollIntervalMs: options.cancelPollIntervalMs,
          metadata: {
            operationId: operation.operationId,
            operationKind: operation.operationKind,
          },
        },
        async (context) => {
          await clearGroupCheckpointReadiness(runtime, group.targetContextName, group.projectionName, options);
          return rebuildAllContextProjectionGroups(
            {
              projectionGroups: [group],
            },
            operation.contextName,
            {},
            context,
          );
        },
      );
    }
    return;
  }

  if (operation.operationKind === "retry-blocked-stream") {
    const projectionKey = requireProjectionOperationField(operation, "projectionKey");
    const streamId = requireProjectionOperationField(operation, "streamId");
    const group = findProjectionGroupForProjectionKey(runtime, projectionKey);
    await runWithRenewedLease(
      options.controlPlane,
      {
        leaseName: createProjectionGroupRunnerLeaseName(group),
        ownerId,
        ttlMs: options.leaseTtlMs,
        renewIntervalMs: options.leaseRenewIntervalMs,
        statementTimeoutMs: options.statementTimeoutMs,
        shouldAbort: () => shouldAbortProjectionOperation(options.controlPlane, operation.operationId, runnerContext),
        abortPollIntervalMs: options.cancelPollIntervalMs,
        metadata: {
          operationId: operation.operationId,
          operationKind: operation.operationKind,
          projectionKey,
          streamId,
        },
      },
      (context) => retryProjectionBlockedStream(runtime, projectionKey, streamId, context),
    );
    return;
  }

  throw new Error(`Projection operation kind '${operation.operationKind}' is not implemented.`);
}

async function clearGroupCheckpointReadiness(
  runtime: Pick<WorkerHostRuntime, "projectionGroups">,
  targetContextName: string,
  projectionName: string,
  options: Readonly<{ onCheckpointsReset?: (checkpointKeys: readonly string[]) => Promise<void> }>,
): Promise<void> {
  if (!options.onCheckpointsReset) {
    return;
  }

  const group = runtime.projectionGroups.find(
    (candidate) => candidate.targetContextName === targetContextName && candidate.projectionName === projectionName,
  );
  if (!group) {
    return;
  }

  try {
    await options.onCheckpointsReset(group.subscriptionRunners.map((runner) => runner.checkpointKey));
  } catch {
    // Readiness clearing is best-effort; the bounded readiness TTL still
    // reaps stale rows.
  }
}

function findProjectionGroupForProjectionKey(
  runtime: Pick<WorkerHostRuntime, "projectionGroups" | "subscriptionRunners">,
  projectionKey: string,
): ContextProjectionGroup {
  const runner = runtime.subscriptionRunners.find((candidate) => candidate.checkpointKey === projectionKey);
  if (!runner) {
    throw new Error(`Runtime is missing subscription runner '${projectionKey}'.`);
  }

  const group = runtime.projectionGroups.find(
    (candidate) =>
      candidate.targetContextName === runner.targetContextName &&
      candidate.projectionName === runner.projectionName &&
      candidate.subscriptionRunners.some((subscriptionRunner) => subscriptionRunner.checkpointKey === projectionKey),
  );
  if (!group) {
    throw new Error(`Runtime is missing projection group for subscription runner '${projectionKey}'.`);
  }

  return group;
}

function requireProjectionOperationField(
  operation: ProjectionOperationRecord,
  fieldName: "projectionName" | "projectionKey" | "streamId",
): string {
  const value = operation[fieldName];
  if (!value) {
    throw new Error(`Projection operation '${operation.operationId}' is missing '${fieldName}'.`);
  }
  return value;
}

export type RunWithRenewedLeaseInput = Readonly<{
  leaseName: string;
  ownerId: string;
  ttlMs: number;
  renewIntervalMs: number;
  statementTimeoutMs?: number;
  shouldAbort?: () => Promise<boolean>;
  abortPollIntervalMs?: number;
  metadata?: Record<string, unknown>;
}>;

async function runWithRenewedLease<T>(
  controlPlane: PlatformControlPlane,
  input: RunWithRenewedLeaseInput,
  work: (context: ProjectionRunContext) => Promise<T>,
): Promise<T> {
  const outcome = await tryRunWithRenewedLease(controlPlane, input, work);
  if (!outcome.acquired) {
    throw new Error(`Projection runner lease '${input.leaseName}' is already active.`);
  }

  return outcome.result;
}

export async function tryRunWithRenewedLease<T>(
  controlPlane: PlatformControlPlane,
  input: RunWithRenewedLeaseInput,
  work: (context: ProjectionRunContext) => Promise<T>,
): Promise<Readonly<{ acquired: true; result: T }> | Readonly<{ acquired: false }>> {
  const lease = await controlPlane.acquireLease({
    leaseName: input.leaseName,
    ownerId: input.ownerId,
    ttlMs: input.ttlMs,
    metadata: input.metadata,
  });
  if (!lease) {
    return { acquired: false };
  }

  let leaseActive = true;
  const abortController = new AbortController();
  const throwIfLeaseLost = () => {
    if (!leaseActive || abortController.signal.aborted) {
      throw new Error(`Lost lease '${lease.leaseName}'.`);
    }
  };
  let renewalInFlight = false;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight) {
      return;
    }
    renewalInFlight = true;
    void controlPlane
      .renewLease(lease, input.ttlMs)
      .then((renewed) => {
        leaseActive = leaseActive && renewed;
        if (!renewed) {
          abortController.abort();
        }
      })
      .catch(() => {
        leaseActive = false;
        abortController.abort();
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, input.renewIntervalMs);
  renewalTimer.unref?.();
  const abortPollTimer =
    input.shouldAbort && input.abortPollIntervalMs && input.abortPollIntervalMs > 0
      ? setInterval(() => {
          void input
            .shouldAbort?.()
            .then((shouldAbort) => {
              if (shouldAbort) {
                leaseActive = false;
                abortController.abort();
              }
            })
            .catch(() => {
              leaseActive = false;
              abortController.abort();
            });
        }, input.abortPollIntervalMs)
      : null;
  abortPollTimer?.unref?.();

  try {
    const result = await work({
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      operationId: typeof input.metadata?.operationId === "string" ? (input.metadata.operationId as string) : undefined,
      signal: abortController.signal,
      statementTimeoutMs: input.statementTimeoutMs,
      throwIfLeaseLost,
    });
    return { acquired: true, result };
  } finally {
    clearInterval(renewalTimer);
    if (abortPollTimer) {
      clearInterval(abortPollTimer);
    }
    await controlPlane.releaseLease(lease);
  }
}

async function isProjectionOperationCancelRequested(
  controlPlane: PlatformControlPlane,
  operationId: string,
): Promise<boolean> {
  const operation = await controlPlane.getProjectionOperation(operationId);
  return operation?.state === "cancel_requested" || operation?.state === "cancelled";
}

async function shouldAbortProjectionOperation(
  controlPlane: PlatformControlPlane,
  operationId: string,
  context?: ProjectionRunContext,
): Promise<boolean> {
  if (context?.signal?.aborted) {
    return true;
  }

  try {
    context?.throwIfLeaseLost?.();
  } catch {
    return true;
  }

  return isProjectionOperationCancelRequested(controlPlane, operationId);
}

async function requireProjectionOperationClaim(succeeded: Promise<boolean> | boolean, operationId: string) {
  if (!(await succeeded)) {
    throw new Error(`Projection operation '${operationId}' claim was lost before the status update completed.`);
  }
}

function createSubscriptionLedgerCompactionRunner(runtime: WorkerHostRuntime): WorkerRunner {
  return {
    name: "projection-ledger-compaction",
    kind: "job",
    priority: () => 0,
    runOnce: async () => {
      const compacted = await compactRuntimeSubscriptionLedgers(runtime);
      return {
        processed: compacted,
        lastGlobalPosition: ZERO_GLOBAL_POSITION,
        state: "caught-up",
      };
    },
  };
}

function createProjectionGenerationRetentionRunner(runtime: WorkerHostRuntime): WorkerRunner {
  return {
    name: "projection-generation-retention",
    kind: "job",
    priority: () => 0,
    runOnce: async () => {
      const cleaned = await cleanupRuntimeProjectionGenerations(runtime);
      return {
        processed: cleaned,
        lastGlobalPosition: ZERO_GLOBAL_POSITION,
        state: "caught-up",
      };
    },
  };
}

function leaseEvent(workerId: string, runner: WorkerRunner, lease: PlatformLease): WorkerLeaseEvent {
  return {
    workerId,
    runnerName: runner.name,
    runnerKind: runner.kind,
    leaseName: lease.leaseName,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  };
}

function projectionOperationEvent(
  operation: ProjectionOperationRecord,
  ownerId: string,
  fencingToken: string,
): WorkerProjectionOperationEvent {
  return {
    operationId: operation.operationId,
    operationKind: operation.operationKind,
    operationState: operation.state,
    workerId: ownerId,
    ownerId,
    fencingToken,
    contextName: operation.contextName,
    projectionName: operation.projectionName,
    projectionKey: operation.projectionKey,
    streamId: operation.streamId,
  };
}

async function runSubscriptionRunnersByOrder(
  runners: readonly ContextSubscriptionRunner[],
  context?: ProjectionRunContext,
): Promise<readonly ProjectorRunResult[]> {
  const results: ProjectorRunResult[] = [];
  const sortedRunners = sortSubscriptionRunners(runners);

  for (let index = 0; index < sortedRunners.length; ) {
    const order = sortedRunners[index].order;
    const sameOrderRunners: ContextSubscriptionRunner[] = [];

    while (index < sortedRunners.length && sortedRunners[index].order === order) {
      sameOrderRunners.push(sortedRunners[index]);
      index += 1;
    }

    context?.throwIfLeaseLost?.();
    results.push(...(await Promise.all(sameOrderRunners.map((runner) => runner.runOnce(context)))));
  }

  return results;
}

function maxGlobalPosition(
  left: ProjectorRunResult["lastGlobalPosition"],
  right: ProjectorRunResult["lastGlobalPosition"],
) {
  return BigInt(left) >= BigInt(right) ? left : right;
}

function getHostPortsForContext(manifest: WorkerContextManifest, hostPorts: Readonly<Record<string, unknown>>) {
  const entries = manifest.hostPorts ?? [];
  if (entries.length === 0) {
    return undefined;
  }

  const resolvedPorts: Record<string, unknown> = {};
  for (const hostPort of entries) {
    resolvedPorts[hostPort.portName] = hostPorts[hostPort.portName];
  }

  return resolvedPorts;
}
