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
import { attachRuntimeLifecycleRegistry, type RuntimeLifecycleRegistry } from "./runtime-lifecycle";
import type { PostgresWorkSignalStore } from "./work-signal-store";
import { runtimeProfileMatches, sourceRuntimeHostMatches } from "./host-runtime-selection";

export type WorkerHostName = "platform-worker";
export type WorkerHostRuntimeProfile = "landing" | "proof" | "public";

export type WorkerContextManifest = Readonly<{
  contextName: string;
  runtimeDeployables?: readonly string[];
  workerRuntimeProfiles?: readonly string[];
  sourceRuntimeDeployables?: readonly string[];
  sourceRuntimeProfiles?: readonly string[];
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
  rescheduleOnCompletion?: (result: ProjectorRunResult) => boolean;
  /**
   * Reserved-capacity runners belong to the loop's critical class: only they
   * may occupy the loop's reserved slots (`reservedRunnerSlots`), which fill
   * before the shared slots on every scheduling pass. Beyond the reservation
   * they compete fairly in the shared rotation. Hot-lane wake runners use
   * this so critical read-after-write wakes are not starved by standard/bulk
   * passes.
   */
  reservedCapacity?: boolean;
  projectionStatusSnapshot?: () => ContextProjectionGroupStatus;
}>;

export type WorkerRunnerLoop = Readonly<{
  start: () => void;
  nudge: () => void;
  stop: () => Promise<void>;
  status: () => Readonly<{
    workerId: string;
    activeRunnerCount: number;
    activeReservedSlotCount: number;
    reservedRunnerSlots: number;
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

type WorkerHostPools = Readonly<
  Record<string, PgTransactionalPool | Readonly<Record<string, PgTransactionalPool>> | undefined>
>;

export const DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_WORKER_STATUS_HEARTBEAT_INTERVAL_MS = 60_000;

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
  /**
   * Slots reserved for `reservedCapacity` runners. Shared runners may occupy
   * at most `maxConcurrentRunners - reservedRunnerSlots` slots; reserved
   * runners fill the reserved slots first and also compete fairly in the
   * shared rotation. The effective reservation is clamped to the reserved
   * runner count and, whenever shared runners exist, to
   * `maxConcurrentRunners - 1`, so the shared class always keeps at least one
   * slot and can never be starved by the reservation itself.
   */
  reservedRunnerSlots?: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  projectionTransactionIdleTimeoutMs?: number;
  pollIntervalMs: number;
  failureBackoffBaseMs?: number;
  failureBackoffMaxMs?: number;
  statusHeartbeatIntervalMs?: number;
  observer?: WorkerRuntimeObserver;
  onError?: (error: unknown, runner: WorkerRunner) => void;
}>;

type LeasedRunnerOutcome = Readonly<
  | {
      leaseAcquired: false;
    }
  | {
      leaseAcquired: true;
      result?: ProjectorRunResult;
    }
>;

type RunnerStatusPublication = Parameters<PlatformControlPlane["recordRunnerStatus"]>[0];
type ProjectionStatusPublication = Parameters<PlatformControlPlane["recordProjectionStatusSnapshot"]>[0];

type PublishedFingerprint = Readonly<{
  fingerprint: string;
  state?: string;
  publishedAtMs: number;
}>;

type WorkerStatusPublishState = {
  heartbeatIntervalMs: number;
  runnerStatuses: Map<string, PublishedFingerprint>;
  projectionSnapshots: Map<string, PublishedFingerprint>;
};

type HeldRunnerLease = {
  runner: WorkerRunner;
  leaseName: string;
  lease: PlatformLease;
  abortController: AbortController;
  leaseActive: boolean;
  renewalInFlight: boolean;
  renewalTimer: ReturnType<typeof setInterval> | null;
  activeRunCount: number;
  releaseAfterActiveRun: boolean;
  releasePromise?: Promise<void>;
};

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
  runtimeProfile?: WorkerHostRuntimeProfile,
): readonly WorkerContextRegistryEntry[] {
  return registry.filter(
    (entry) =>
      isWorkerHostActive(entry.manifest, hostName, runtimeProfile) ||
      isWorkerHostSourceOnly(entry.manifest, hostName, runtimeProfile),
  );
}

export function getWorkerHostContextNames<TRegistry extends WorkerContextRegistry>(
  registry: TRegistry,
  hostName: WorkerHostName,
  runtimeProfile?: WorkerHostRuntimeProfile,
): readonly WorkerHostContextName<TRegistry>[] {
  return getWorkerHostEntries(registry, hostName, runtimeProfile).map(
    (entry) => entry.contextName as WorkerHostContextName<TRegistry>,
  );
}

export function createWorkerHost(
  registry: WorkerContextRegistry,
  hostName: WorkerHostName,
  options: Readonly<{
    pools: WorkerHostPools;
    hostPorts?: Readonly<Record<string, unknown>>;
    runtimeProfile?: WorkerHostRuntimeProfile;
    runtimeLifecycle?: RuntimeLifecycleRegistry;
  }>,
): WorkerHostRuntime {
  const entries = getWorkerHostEntries(registry, hostName, options.runtimeProfile);
  const services = Object.fromEntries(
    entries.map((entry) => {
      const pool = getContextPool(options.pools, hostName, entry.contextName);
      const servicePool = attachRuntimeLifecycleRegistry(createProjectionAwarePool(pool), options.runtimeLifecycle);

      return [
        entry.contextName,
        entry.module.createServices(
          servicePool,
          getHostPortsForContext(entry.manifest, options.hostPorts ?? {}) as never,
          { notificationWaiterPool: servicePool },
        ),
      ];
    }),
  );

  const mountedContexts = entries.map((entry) => {
    const pool = getContextPool(options.pools, hostName, entry.contextName);
    const contextServices = services[entry.contextName];
    const mountRole = getWorkerHostMountRole(entry.manifest, hostName, options.runtimeProfile);

    return {
      contextName: entry.contextName,
      mountRole,
      module: entry.module,
      services: contextServices,
      pool,
      projectionHandlerSets:
        mountRole === "source-only" ? [] : (entry.module.projectionHandlerSets?.(contextServices as never) ?? []),
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

function getContextPool(pools: WorkerHostPools, hostName: WorkerHostName, contextName: string): PgTransactionalPool {
  const pool = pools[contextName];
  if (isPgTransactionalPool(pool)) {
    return pool;
  }

  throw new Error(`Worker host '${hostName}' is missing a pool for context '${contextName}'.`);
}

function isPgTransactionalPool(value: unknown): value is PgTransactionalPool {
  return Boolean(value && typeof value === "object" && "query" in value);
}

export function collectWorkerRunners(
  runtime: WorkerHostRuntime,
  options: Readonly<{
    controlPlane?: PlatformControlPlane;
    projectionOperationClaimTtlMs?: number;
    projectionOperationLeaseTtlMs?: number;
    projectionOperationLeaseRenewIntervalMs?: number;
    projectionTransactionIdleTimeoutMs?: number;
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
      createProjectionGroupWorkerRunner(group, {
        idleInTransactionSessionTimeoutMs:
          options.projectionTransactionIdleTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS,
        onCheckpointsAdvanced,
        onCheckpointsReset,
      }),
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
          idleInTransactionSessionTimeoutMs:
            options.projectionTransactionIdleTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS,
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
  const reservedRunners = options.runners.filter((runner) => runner.reservedCapacity === true);
  const reservedRunnerSlots = clampReservedRunnerSlots(
    options.reservedRunnerSlots ?? 0,
    options.maxConcurrentRunners,
    reservedRunners.length,
    options.runners.length - reservedRunners.length,
  );
  const sharedRunnerSlots = options.maxConcurrentRunners - reservedRunnerSlots;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextReservedRunnerIndex = 0;
  let nextRunnerIndex = 0;
  let activeReservedSlotCount = 0;
  let activeSharedSlotCount = 0;
  let leaseMissCount = 0;
  let scheduleQueued = false;
  let scheduling = false;
  let scheduleAgainAfterCurrentPass = false;
  const heldRunnerLeases = new Map<string, HeldRunnerLease>();
  const failureBackoffBaseMs = Math.max(0, Math.floor(options.failureBackoffBaseMs ?? options.pollIntervalMs * 5));
  const failureBackoffMaxMs = Math.max(failureBackoffBaseMs, Math.floor(options.failureBackoffMaxMs ?? 30_000));
  const statusPublishState: WorkerStatusPublishState = {
    heartbeatIntervalMs: Math.max(
      0,
      Math.floor(options.statusHeartbeatIntervalMs ?? DEFAULT_WORKER_STATUS_HEARTBEAT_INTERVAL_MS),
    ),
    runnerStatuses: new Map(),
    projectionSnapshots: new Map(),
  };

  const queueImmediateSchedule = () => {
    if (stopped) {
      return;
    }
    if (scheduling) {
      scheduleAgainAfterCurrentPass = true;
      return;
    }
    if (scheduleQueued) {
      return;
    }

    scheduleQueued = true;
    const immediate = setImmediate(() => {
      scheduleQueued = false;
      schedule();
    });
    immediate.unref?.();
  };

  const releaseHeldRunnerLease = async (heldLease: HeldRunnerLease, scheduleAfterRelease = false): Promise<void> => {
    heldLease.leaseActive = false;
    heldLease.abortController.abort();
    if (heldLease.renewalTimer) {
      clearInterval(heldLease.renewalTimer);
      heldLease.renewalTimer = null;
    }

    if (!heldLease.releasePromise) {
      heldLease.releasePromise = options.controlPlane.releaseLease(heldLease.lease).finally(() => {
        if (heldRunnerLeases.get(heldLease.leaseName) === heldLease) {
          heldRunnerLeases.delete(heldLease.leaseName);
        }
      });
    }

    await heldLease.releasePromise;
    if (scheduleAfterRelease) {
      queueImmediateSchedule();
    }
  };

  const dropHeldRunnerLeaseAfterRenewalFailure = (heldLease: HeldRunnerLease, error?: unknown): void => {
    if (!heldLease.leaseActive) {
      return;
    }

    heldLease.leaseActive = false;
    heldLease.abortController.abort();
    if (heldLease.renewalTimer) {
      clearInterval(heldLease.renewalTimer);
      heldLease.renewalTimer = null;
    }
    options.observer?.leaseRenewFailed?.({
      ...leaseEvent(options.workerId, heldLease.runner, heldLease.lease),
      ...(error === undefined ? {} : { error }),
    });
    if (heldLease.activeRunCount > 0) {
      heldLease.releaseAfterActiveRun = true;
      return;
    }

    void releaseHeldRunnerLease(heldLease, true).catch((releaseError: unknown) => {
      options.onError?.(releaseError, heldLease.runner);
    });
  };

  const startLeaseRenewal = (heldLease: HeldRunnerLease): void => {
    heldLease.renewalTimer = setInterval(() => {
      if (heldLease.renewalInFlight || !heldLease.leaseActive) {
        return;
      }

      heldLease.renewalInFlight = true;
      void options.controlPlane
        .renewLease(heldLease.lease, options.leaseTtlMs)
        .then((renewed) => {
          if (!renewed) {
            dropHeldRunnerLeaseAfterRenewalFailure(heldLease);
          }
        })
        .catch((error: unknown) => {
          dropHeldRunnerLeaseAfterRenewalFailure(heldLease, error);
        })
        .finally(() => {
          heldLease.renewalInFlight = false;
        });
    }, options.leaseRenewIntervalMs);
    heldLease.renewalTimer.unref?.();
  };

  const acquireHeldRunnerLease = async (runner: WorkerRunner): Promise<HeldRunnerLease | null> => {
    const leaseName = createWorkerRunnerLeaseName(runner);
    const existingLease = heldRunnerLeases.get(leaseName);
    if (existingLease?.leaseActive && !existingLease.abortController.signal.aborted) {
      return existingLease;
    }
    if (existingLease) {
      await releaseHeldRunnerLease(existingLease);
    }

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
      return null;
    }

    const heldLease: HeldRunnerLease = {
      runner,
      leaseName,
      lease,
      abortController: new AbortController(),
      leaseActive: true,
      renewalInFlight: false,
      renewalTimer: null,
      activeRunCount: 0,
      releaseAfterActiveRun: false,
    };
    heldRunnerLeases.set(leaseName, heldLease);
    startLeaseRenewal(heldLease);
    return heldLease;
  };

  const scheduleTimer = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(schedule, options.pollIntervalMs);
    timer.unref?.();
  };

  const startRunner = (runner: WorkerRunner, slotPool: "reserved" | "shared") => {
    const runAbortController = new AbortController();
    let completedResult: ProjectorRunResult | undefined;
    let leaseAcquired = false;
    let acquiredLease: HeldRunnerLease | null = null;
    const promise = acquireHeldRunnerLease(runner)
      .then((heldLease) => {
        acquiredLease = heldLease ?? null;
        return heldLease
          ? runLeasedRunner(
              options,
              runner,
              heldLease,
              releaseHeldRunnerLease,
              runAbortController.signal,
              statusPublishState,
            )
          : ({ leaseAcquired: false } satisfies LeasedRunnerOutcome);
      })
      .then((outcome) => {
        if (!outcome.leaseAcquired) {
          leaseMissCount += 1;
          return;
        }
        leaseAcquired = true;
        completedResult = outcome.result;
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
        if (slotPool === "reserved") {
          activeReservedSlotCount -= 1;
        } else {
          activeSharedSlotCount -= 1;
        }
        if (leaseAcquired) {
          // A projection-group runner that finished with nothing to process but
          // still has parked blocked streams must not keep holding the shared
          // `projection-group:<name>` lease. Blocked-stream retry and rebuild
          // projection operations acquire that exact lease; while an idle group
          // runner (frequently on another worker) holds it, every such operation
          // fails with "Projection runner lease ... is already active" and the
          // parked poison can never be re-applied — no projection-handler,
          // config, or migration fix can bite because the retry apply path never
          // runs. Yielding the idle-but-degraded lease lets the queued operation
          // acquire it and execute the (fixed) retry-apply path.
          if (acquiredLease && shouldYieldRunnerLeaseForPendingOperation(runner, completedResult)) {
            // Release without an immediate reschedule: the group runner has no
            // work of its own, so let the normal poll tick re-run it while the
            // freed lease stays available for the queued retry/rebuild operation.
            void releaseHeldRunnerLease(acquiredLease, false).catch((error: unknown) => {
              options.onError?.(error, runner);
            });
          }
          try {
            if (shouldRescheduleAfterCompletion(runner, completedResult)) {
              queueImmediateSchedule();
            }
          } catch (error) {
            options.onError?.(error, runner);
          }
        }
      });
    active.add(promise);
    activeAbortControllers.set(promise, runAbortController);
    activeRunnerNames.add(runner.name);
    if (slotPool === "reserved") {
      activeReservedSlotCount += 1;
    } else {
      activeSharedSlotCount += 1;
    }
  };

  const schedule = () => {
    if (stopped) {
      return;
    }

    scheduling = true;
    const now = Date.now();
    try {
      // Reserved slots fill first and accept only reserved-capacity runners, so
      // a critical runner always finds capacity no matter how busy the shared
      // class is, and shared runners can never occupy the reserved slots.
      for (
        let attempts = 0;
        attempts < reservedRunners.length && activeReservedSlotCount < reservedRunnerSlots;
        attempts += 1
      ) {
        const selection = selectNextRunner(
          reservedRunners,
          activeRunnerNames,
          failedRunnerBackoffs,
          nextReservedRunnerIndex,
          now,
        );
        if (!selection) {
          break;
        }
        nextReservedRunnerIndex = (selection.index + 1) % reservedRunners.length;
        startRunner(selection.runner, "reserved");
      }

      // The shared slots keep the original fair rotation across every runner
      // class, so reserved runners beyond their reservation compete equally and
      // the shared class is never starved by the reservation itself.
      for (
        let attempts = 0;
        attempts < options.runners.length && activeSharedSlotCount < sharedRunnerSlots;
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
        nextRunnerIndex = (selection.index + 1) % options.runners.length;
        startRunner(selection.runner, "shared");
      }
    } finally {
      scheduling = false;
    }

    scheduleTimer();
    if (scheduleAgainAfterCurrentPass) {
      scheduleAgainAfterCurrentPass = false;
      queueImmediateSchedule();
    }
  };

  return {
    start: () => schedule(),
    nudge: () => queueImmediateSchedule(),
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      for (const abortController of activeAbortControllers.values()) {
        abortController.abort();
      }
      await Promise.allSettled([...active]);
      await Promise.allSettled([...heldRunnerLeases.values()].map((heldLease) => releaseHeldRunnerLease(heldLease)));
    },
    status: () => ({
      workerId: options.workerId,
      activeRunnerCount: active.size,
      activeReservedSlotCount: activeReservedSlotCount,
      reservedRunnerSlots,
      leaseMissCount,
      stopped,
    }),
  };
}

function shouldRescheduleAfterCompletion(runner: WorkerRunner, result?: ProjectorRunResult): boolean {
  if (!result) {
    return false;
  }

  return result.processed > 0 || runner.rescheduleOnCompletion?.(result) === true;
}

// Blocked-stream retry and rebuild projection operations acquire the same
// `projection-group:<name>` lease that the continuously scheduled
// projection-group runner holds. A caught-up group runner (processed nothing)
// that still has parked blocked streams has no work of its own to do, so it
// must release that lease instead of hoarding it — otherwise the queued
// recovery operation can never acquire it and the parked poison is stuck. A
// group that actually advanced (processed > 0) keeps its lease so healthy
// replay is never churned.
function shouldYieldRunnerLeaseForPendingOperation(runner: WorkerRunner, result?: ProjectorRunResult): boolean {
  return (
    runner.kind === "projection-group" &&
    result !== undefined &&
    result.processed === 0 &&
    (result.blockedStreams ?? 0) > 0
  );
}

function clampReservedRunnerSlots(
  requestedSlots: number,
  maxConcurrentRunners: number,
  reservedRunnerCount: number,
  sharedRunnerCount: number,
): number {
  const maxReservableSlots = sharedRunnerCount > 0 ? maxConcurrentRunners - 1 : maxConcurrentRunners;
  return Math.max(0, Math.min(Math.floor(requestedSlots), reservedRunnerCount, maxReservableSlots));
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

async function maybeRecordRunnerStatus(
  options: WorkerRunnerLoopOptions,
  publishState: WorkerStatusPublishState,
  input: RunnerStatusPublication,
  publishOptions: Readonly<{ force?: boolean }> = {},
): Promise<void> {
  const fingerprint = stableJsonFingerprint({
    runnerName: input.runnerName,
    runnerKind: input.runnerKind,
    state: input.state,
    lastProcessed: input.lastProcessed ?? null,
    lastError: input.lastError ?? null,
  });
  const previous = publishState.runnerStatuses.get(input.runnerName);
  const nowMs = Date.now();
  const heartbeatDue = previous !== undefined && nowMs - previous.publishedAtMs >= publishState.heartbeatIntervalMs;
  const shouldPublish =
    publishOptions.force === true ||
    previous === undefined ||
    heartbeatDue ||
    (input.state === "running"
      ? previous.state !== "running" && previous.state !== "caught-up"
      : previous.fingerprint !== fingerprint);

  if (!shouldPublish) {
    return;
  }

  await options.controlPlane.recordRunnerStatus(input);
  publishState.runnerStatuses.set(input.runnerName, {
    fingerprint,
    state: input.state,
    publishedAtMs: nowMs,
  });
}

async function maybeRecordProjectionStatusSnapshot(
  options: WorkerRunnerLoopOptions,
  publishState: WorkerStatusPublishState,
  input: ProjectionStatusPublication,
  publishOptions: Readonly<{ force?: boolean }> = {},
): Promise<void> {
  const fingerprint = stableJsonFingerprint({
    projectionKey: input.projectionKey,
    targetContextName: input.targetContextName,
    projectionName: input.projectionName,
    runnerName: input.runnerName,
    status: input.status,
  });
  const previous = publishState.projectionSnapshots.get(input.projectionKey);
  const nowMs = Date.now();
  const heartbeatDue = previous !== undefined && nowMs - previous.publishedAtMs >= publishState.heartbeatIntervalMs;
  if (
    publishOptions.force !== true &&
    previous !== undefined &&
    previous.fingerprint === fingerprint &&
    !heartbeatDue
  ) {
    return;
  }

  await options.controlPlane.recordProjectionStatusSnapshot(input);
  publishState.projectionSnapshots.set(input.projectionKey, {
    fingerprint,
    publishedAtMs: nowMs,
  });
}

function stableJsonFingerprint(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
  );
}

async function runLeasedRunner(
  options: WorkerRunnerLoopOptions,
  runner: WorkerRunner,
  heldLease: HeldRunnerLease,
  releaseHeldRunnerLease: (heldLease: HeldRunnerLease, scheduleAfterRelease?: boolean) => Promise<void>,
  runSignal?: AbortSignal,
  statusPublishState?: WorkerStatusPublishState,
): Promise<LeasedRunnerOutcome> {
  if (runSignal?.aborted) {
    return { leaseAcquired: true };
  }

  const lease = heldLease.lease;
  heldLease.activeRunCount += 1;
  const abortController = new AbortController();
  const abortForStop = () => abortController.abort();
  const abortForLeaseLoss = () => abortController.abort();
  if (runSignal?.aborted) {
    abortController.abort();
  } else {
    runSignal?.addEventListener("abort", abortForStop, { once: true });
  }
  if (heldLease.abortController.signal.aborted) {
    abortController.abort();
  } else {
    heldLease.abortController.signal.addEventListener("abort", abortForLeaseLoss, { once: true });
  }
  const stoppedCooperatively = () => runSignal?.aborted === true && abortController.signal.aborted;
  const heldLeaseLost = () => !heldLease.leaseActive || heldLease.abortController.signal.aborted;
  const throwIfLeaseLost = () => {
    if (heldLeaseLost() || abortController.signal.aborted) {
      throw new Error(`Lost lease '${lease.leaseName}'.`);
    }
  };
  const publishState = statusPublishState ?? {
    heartbeatIntervalMs: DEFAULT_WORKER_STATUS_HEARTBEAT_INTERVAL_MS,
    runnerStatuses: new Map<string, PublishedFingerprint>(),
    projectionSnapshots: new Map<string, PublishedFingerprint>(),
  };

  try {
    await maybeRecordRunnerStatus(options, publishState, {
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
      idleInTransactionSessionTimeoutMs:
        options.projectionTransactionIdleTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS,
      throwIfLeaseLost,
    };
    const result = await runner.runOnce(runnerContext);
    throwIfLeaseLost();
    const projectionStatusSnapshot = runner.projectionStatusSnapshot?.();
    options.observer?.runnerCompleted?.({
      ...leaseEvent(options.workerId, runner, lease),
      processed: result.processed,
      state: result.state,
      operationId: runnerContext.operationId,
    });
    const state = result.state === "degraded" ? "degraded" : result.processed > 0 ? "running" : "caught-up";

    throwIfLeaseLost();
    await maybeRecordRunnerStatus(
      options,
      publishState,
      {
        runnerName: runner.name,
        runnerKind: runner.kind,
        state,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        lastProcessed: result.processed,
        lastError:
          state === "degraded"
            ? `${projectionStatusSnapshot?.handlerKind === "reaction" ? "Reaction" : "Projection"} has ${
                result.blockedStreams ?? 0
              } blocked stream(s) and ${result.poisonEvents ?? 0} poison event(s).`
            : null,
      },
      { force: result.processed > 0 || state === "degraded" },
    );

    if (projectionStatusSnapshot) {
      throwIfLeaseLost();
      await maybeRecordProjectionStatusSnapshot(
        options,
        publishState,
        {
          projectionKey: `${projectionStatusSnapshot.targetContextName}.${projectionStatusSnapshot.projectionName}`,
          targetContextName: projectionStatusSnapshot.targetContextName,
          projectionName: projectionStatusSnapshot.projectionName,
          runnerName: runner.name,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          status: projectionStatusSnapshot as unknown as Record<string, unknown>,
        },
        { force: result.processed > 0 || state === "degraded" },
      );
    }
    return { leaseAcquired: true, result };
  } catch (error) {
    if (stoppedCooperatively()) {
      return { leaseAcquired: true };
    }
    if (heldLeaseLost()) {
      return { leaseAcquired: true };
    }
    options.observer?.runnerFailed?.({
      ...leaseEvent(options.workerId, runner, lease),
      error,
    });
    if (!abortController.signal.aborted) {
      await maybeRecordRunnerStatus(
        options,
        publishState,
        {
          runnerName: runner.name,
          runnerKind: runner.kind,
          state: "error",
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          lastError: error instanceof Error ? error.message : String(error),
        },
        { force: true },
      );
    }
    throw error;
  } finally {
    runSignal?.removeEventListener("abort", abortForStop);
    heldLease.abortController.signal.removeEventListener("abort", abortForLeaseLoss);
    heldLease.activeRunCount = Math.max(0, heldLease.activeRunCount - 1);
    if (heldLease.releaseAfterActiveRun && heldLease.activeRunCount === 0) {
      await releaseHeldRunnerLease(heldLease, true);
    }
  }

  return { leaseAcquired: true };
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
    idleInTransactionSessionTimeoutMs?: number;
    revisionStaleBehavior?: "reset" | "reject";
    onCheckpointsAdvanced?: (
      status: ContextProjectionGroupStatus,
      previousStatus?: ContextProjectionGroupStatus,
    ) => Promise<void>;
    onCheckpointsReset?: (checkpointKeys: readonly string[]) => Promise<void>;
  }> = {},
): WorkerRunner {
  const revisionStaleBehavior = options.revisionStaleBehavior ?? "reset";
  const idleInTransactionSessionTimeoutMs =
    options.idleInTransactionSessionTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS;
  let rebuildingRevision: number | null = null;

  return {
    name: createProjectionGroupRunnerName(group),
    kind: "projection-group",
    priority: () => BigInt(group.getStatus().outstandingEventCount),
    projectionStatusSnapshot: () => group.getStatus(),
    runOnce: async (context) => {
      const runContext: ProjectionRunContext = {
        ...context,
        idleInTransactionSessionTimeoutMs:
          context?.idleInTransactionSessionTimeoutMs ?? idleInTransactionSessionTimeoutMs,
      };
      try {
        runContext.throwIfLeaseLost?.();
        const status = await group.refreshStatus();
        if (status.revisionStale && revisionStaleBehavior === "reject") {
          throw new ProjectionGroupRevisionStaleError(group);
        }
        if (status.revisionStale && rebuildingRevision !== group.projectionRevision) {
          runContext.throwIfLeaseLost?.();
          await resetProjectionGroup(group, runContext);
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

        for (const result of await runSubscriptionRunnersByOrder(group.subscriptionRunners, runContext)) {
          processed += result.processed;
          lastGlobalPosition = maxGlobalPosition(lastGlobalPosition, result.lastGlobalPosition);
          blockedStreams += result.blockedStreams ?? 0;
          poisonEvents += result.poisonEvents ?? 0;
        }

        if (processed === 0 && blockedStreams === 0) {
          runContext.throwIfLeaseLost?.();
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
    idleInTransactionSessionTimeoutMs: number;
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
    idleInTransactionSessionTimeoutMs: number;
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
    idleInTransactionSessionTimeoutMs: number;
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
        idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs,
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
          idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs,
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
        idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs,
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
  idleInTransactionSessionTimeoutMs?: number;
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
      idleInTransactionSessionTimeoutMs:
        input.idleInTransactionSessionTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS,
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
  const runContext = {
    ...context,
    sourceHeadGlobalPositionCache: new Map<string, Promise<ProjectorRunResult["lastGlobalPosition"]>>(),
  } as ProjectionRunContext;

  for (let index = 0; index < sortedRunners.length; ) {
    const order = sortedRunners[index].order;
    const sameOrderRunners: ContextSubscriptionRunner[] = [];

    while (index < sortedRunners.length && sortedRunners[index].order === order) {
      sameOrderRunners.push(sortedRunners[index]);
      index += 1;
    }

    context?.throwIfLeaseLost?.();
    results.push(...(await Promise.all(sameOrderRunners.map((runner) => runner.runOnce(runContext)))));
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

function getWorkerHostMountRole(
  manifest: WorkerContextManifest,
  hostName: WorkerHostName,
  runtimeProfile?: WorkerHostRuntimeProfile,
): "active" | "source-only" {
  return isWorkerHostActive(manifest, hostName, runtimeProfile) ? "active" : "source-only";
}

function isWorkerHostActive(
  manifest: WorkerContextManifest,
  hostName: WorkerHostName,
  runtimeProfile?: WorkerHostRuntimeProfile,
): boolean {
  return Boolean(
    manifest.runtimeDeployables?.includes(hostName) &&
    runtimeProfileMatches(manifest.workerRuntimeProfiles, runtimeProfile),
  );
}

function isWorkerHostSourceOnly(
  manifest: WorkerContextManifest,
  hostName: WorkerHostName,
  runtimeProfile?: WorkerHostRuntimeProfile,
): boolean {
  return sourceRuntimeHostMatches(manifest, hostName, runtimeProfile);
}
