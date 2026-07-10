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
import {
  DEFAULT_PROJECTION_OPERATION_MAX_ATTEMPTS,
  DEFAULT_PROJECTION_OPERATION_RETRY_BACKOFF_BASE_MS,
  DEFAULT_PROJECTION_OPERATION_RETRY_BACKOFF_MAX_MS,
  type PlatformControlPlane,
  type PlatformLease,
  type ProjectionOperationRecord,
} from "./control-plane";
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
  /**
   * Overrides the single-flight lease identity for this runner. Defaults to
   * `${kind}:${name}`. Use this when two runners that share a `name` (for
   * stable observability/metrics) must NOT share one platform-wide lease
   * because they cover different work scopes. The projection wake lane runners
   * set this to their hosted-context cohort so a lane held by a worker that
   * does not host a given target context can never starve that context's
   * intents platform-wide (see `createProjectionWakeSchedulerRunners`).
   */
  leaseName?: string;
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
  /**
   * Refreshes this runner's cached backlog so a subsequent `priority()` call
   * reflects the live source head. The loop invokes this on idle runners whose
   * cached `priority()` reads 0 so a group that fell behind WITHOUT running
   * (e.g. backlog appended during a wake-relay outage, which leaves no wake
   * intent and no runner pass to update the cache) surfaces a positive
   * priority and re-enters the fair rotation instead of starving behind an
   * always-positive high-backlog group (the discovery cascade). Read-only: it
   * must never process events, acquire the run lease, or advance a checkpoint,
   * so exactly-once and the #4730 idle-lease yield stay intact.
   */
  refreshPriority?: () => Promise<void>;
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
export const DEFAULT_PROJECTION_OPERATION_TIMEOUT_MS = 600_000;
export const DEFAULT_PROJECTION_OPERATION_REBUILD_TIMEOUT_MS = 7_200_000;
const DEFAULT_PROJECTION_OPERATION_CLAIM_TTL_MS = 120_000;
const DEFAULT_PROJECTION_OPERATION_LEASE_TTL_MS = 120_000;
const DEFAULT_PROJECTION_OPERATION_LEASE_RENEW_INTERVAL_MS = 30_000;
const DEFAULT_PROJECTION_OPERATION_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_PROJECTION_OPERATION_CANCEL_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PROJECTION_OPERATION_LEASE_ACQUIRE_TIMEOUT_MS = 15_000;
const DEFAULT_PROJECTION_OPERATION_LEASE_ACQUIRE_RETRY_INTERVAL_MS = 500;

/**
 * A projection operation could not acquire the projection-group runner lease
 * it targets (the scheduled group runner or another operation holds it). This
 * failure class is transient contention, not a broken operation: the worker
 * requeues the operation with backoff instead of dead-lettering it.
 */
export class ProjectionRunnerLeaseUnavailableError extends Error {
  readonly leaseName: string;

  constructor(leaseName: string) {
    super(`Projection runner lease '${leaseName}' is already active.`);
    this.name = "ProjectionRunnerLeaseUnavailableError";
    this.leaseName = leaseName;
  }
}

/**
 * A projection operation exceeded its execution deadline and was aborted so
 * the operation executor cannot be pinned by a hung operation. The claim is
 * still valid when this is thrown, so the failure is recorded with this
 * message instead of leaving the operation silently `running` forever.
 */
export class ProjectionOperationTimedOutError extends Error {
  constructor(operationId: string, timeoutMs: number) {
    super(`Projection operation '${operationId}' timed out after ${timeoutMs}ms and was aborted.`);
    this.name = "ProjectionOperationTimedOutError";
  }
}

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
  /**
   * Interval at which the loop refreshes the cached backlog of idle runners
   * (those exposing `refreshPriority` whose current `priority()` reads 0) so a
   * group that fell behind without running is not permanently invisible to
   * backlog-priority selection. `0` (the default) disables the sweep, which
   * keeps loops whose runners expose no `refreshPriority` free of extra work.
   */
  priorityRefreshIntervalMs?: number;
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
    projectionTransactionIdleTimeoutMs?: number;
    workSignalStore?: Pick<PostgresWorkSignalStore, "recordCheckpointReady" | "clearCheckpointReadiness">;
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

  return [
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
}

/**
 * Projection operation executors run in their own runner group so queued
 * recovery operations are never starved by projection-group backlog priority
 * (issue #4496: a single shared-loop consumer left retry operations queued for
 * hours). Each runner claims one operation at a time; `runnerCount` scales
 * cluster-wide concurrency, and per-projection-group leases still serialize
 * operations that target the same group.
 */
export function collectProjectionOperationRunners(
  runtime: WorkerHostRuntime,
  options: Readonly<{
    controlPlane: PlatformControlPlane;
    runnerCount?: number;
    claimTtlMs?: number;
    leaseTtlMs?: number;
    leaseRenewIntervalMs?: number;
    projectionTransactionIdleTimeoutMs?: number;
    statementTimeoutMs?: number;
    cancelPollIntervalMs?: number;
    operationTimeoutMs?: number;
    rebuildOperationTimeoutMs?: number;
    maxAttempts?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
    leaseAcquireTimeoutMs?: number;
    leaseAcquireRetryIntervalMs?: number;
    workSignalStore?: Pick<PostgresWorkSignalStore, "clearCheckpointReadiness">;
    observer?: WorkerRuntimeObserver;
  }>,
): readonly WorkerRunner[] {
  const onCheckpointsReset = options.workSignalStore
    ? async (checkpointKeys: readonly string[]) => {
        await options.workSignalStore?.clearCheckpointReadiness({ checkpointKeys });
      }
    : undefined;
  const runnerOptions: ProjectionOperationRunnerOptions = {
    controlPlane: options.controlPlane,
    claimTtlMs: options.claimTtlMs ?? DEFAULT_PROJECTION_OPERATION_CLAIM_TTL_MS,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_PROJECTION_OPERATION_LEASE_TTL_MS,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs ?? DEFAULT_PROJECTION_OPERATION_LEASE_RENEW_INTERVAL_MS,
    idleInTransactionSessionTimeoutMs:
      options.projectionTransactionIdleTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_PROJECTION_OPERATION_STATEMENT_TIMEOUT_MS,
    cancelPollIntervalMs: options.cancelPollIntervalMs ?? DEFAULT_PROJECTION_OPERATION_CANCEL_POLL_INTERVAL_MS,
    operationTimeoutMs: options.operationTimeoutMs ?? DEFAULT_PROJECTION_OPERATION_TIMEOUT_MS,
    rebuildOperationTimeoutMs: options.rebuildOperationTimeoutMs ?? DEFAULT_PROJECTION_OPERATION_REBUILD_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_PROJECTION_OPERATION_MAX_ATTEMPTS,
    retryBackoffBaseMs: options.retryBackoffBaseMs ?? DEFAULT_PROJECTION_OPERATION_RETRY_BACKOFF_BASE_MS,
    retryBackoffMaxMs: options.retryBackoffMaxMs ?? DEFAULT_PROJECTION_OPERATION_RETRY_BACKOFF_MAX_MS,
    leaseAcquireTimeoutMs: options.leaseAcquireTimeoutMs ?? DEFAULT_PROJECTION_OPERATION_LEASE_ACQUIRE_TIMEOUT_MS,
    leaseAcquireRetryIntervalMs:
      options.leaseAcquireRetryIntervalMs ?? DEFAULT_PROJECTION_OPERATION_LEASE_ACQUIRE_RETRY_INTERVAL_MS,
    onCheckpointsReset,
    observer: options.observer,
  };
  const runnerCount = Math.max(1, Math.floor(options.runnerCount ?? 1));

  return Array.from({ length: runnerCount }, (_, index) =>
    createProjectionOperationWorkerRunner(
      runtime,
      runnerOptions,
      index === 0 ? "projection-operations" : `projection-operations-${index + 1}`,
    ),
  );
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
  const refreshableRunners = options.runners.filter((runner) => runner.refreshPriority);
  const priorityRefreshIntervalMs = Math.max(0, Math.floor(options.priorityRefreshIntervalMs ?? 0));
  let priorityRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let priorityRefreshing = false;
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
          // A projection-group runner that finished an idle pass (processed
          // nothing) must not keep holding the shared `projection-group:<name>`
          // lease. Two consumer classes acquire that exact lease, frequently
          // from another worker:
          // - blocked-stream retry / rebuild projection operations (#4496):
          //   while an idle holder keeps the lease, every retry fails with
          //   "Projection runner lease ... is already active" and parked poison
          //   can never be re-applied;
          // - projection WAKE runners (#4730): the hot/standard wake lanes run
          //   the group under this lease for read-after-write freshness. A
          //   hoarded idle lease forces every wake into claim/defer loops
          //   (observed live: a checkout hot intent deferred
          //   "lease was busy" every second for 3+ minutes, then completed
          //   already-satisfied) — the push-wake fast path degrades to the
          //   polling loop's rotation latency, which stretches to minutes
          //   during post-rollout replay.
          // Busy passes (processed > 0) keep the lease and reschedule
          // immediately, so backlog draining never churns its lease.
          if (acquiredLease && shouldYieldIdleProjectionGroupLease(runner, completedResult)) {
            // Release without an immediate reschedule: the group runner has no
            // work of its own, so let the normal poll tick re-run it while the
            // freed lease stays available for queued wakes and operations.
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

  // Idle-runner priority refresh (anti-starvation). A projection group that
  // fell behind WITHOUT running keeps a cached backlog of 0, so `priority()`
  // reads 0 and `selectNextRunner` never distinguishes it from a genuinely
  // caught-up group: it can only ever be a fallback, which never fires while
  // the discovery cascade holds positive priority. Re-reading the live source
  // head for such idle runners surfaces their real backlog as a positive
  // priority, so they re-enter the fair rotation and drain. This is read-only
  // (no lease, no event processing, no checkpoint advance), so exactly-once,
  // the #4730 idle-lease yield, and the #4643 wake-cohort anti-starvation are
  // all preserved.
  const refreshIdleRunnerPriorities = async (): Promise<void> => {
    if (stopped || priorityRefreshing || refreshableRunners.length === 0) {
      return;
    }
    priorityRefreshing = true;
    const now = Date.now();
    let surfacedBacklog = false;
    try {
      for (const runner of refreshableRunners) {
        if (stopped) {
          break;
        }
        // Draining runners refresh their own cache each pass, and backing-off
        // runners cannot be made eligible by a refresh, so skip both.
        if (activeRunnerNames.has(runner.name)) {
          continue;
        }
        const failedBackoff = failedRunnerBackoffs.get(runner.name);
        if (failedBackoff && failedBackoff.eligibleAt > now) {
          continue;
        }
        // Only groups that currently look caught-up (cached priority 0) can be
        // hiding orphaned backlog; positive-priority groups are already in the
        // rotation, so re-reading them would only add source-head load.
        if (resolveRunnerPriority(runner) > 0n) {
          continue;
        }
        try {
          await runner.refreshPriority?.();
        } catch (error) {
          options.onError?.(error, runner);
          continue;
        }
        if (resolveRunnerPriority(runner) > 0n) {
          surfacedBacklog = true;
        }
      }
    } finally {
      priorityRefreshing = false;
    }
    if (surfacedBacklog) {
      queueImmediateSchedule();
    }
  };

  const startPriorityRefreshTimer = () => {
    if (priorityRefreshIntervalMs <= 0 || refreshableRunners.length === 0 || priorityRefreshTimer) {
      return;
    }
    priorityRefreshTimer = setInterval(() => {
      void refreshIdleRunnerPriorities();
    }, priorityRefreshIntervalMs);
    priorityRefreshTimer.unref?.();
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
    start: () => {
      startPriorityRefreshTimer();
      schedule();
    },
    nudge: () => queueImmediateSchedule(),
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (priorityRefreshTimer) {
        clearInterval(priorityRefreshTimer);
        priorityRefreshTimer = null;
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

// Projection wake runners (#4730) and blocked-stream retry / rebuild
// projection operations (#4496) acquire the same `projection-group:<name>`
// lease that the continuously scheduled projection-group runner holds. A group
// runner whose pass processed nothing has no work of its own, so it must
// release that lease instead of hoarding it: a hoarded idle lease starves
// every wake into claim/defer loops (read-after-write freshness degrades to
// the polling loop's rotation latency, which stretches to minutes during
// post-rollout replay) and blocks queued recovery operations. This
// deliberately reverses the earlier hold-when-idle-and-healthy behavior —
// holding N idle leases costs a renewal per lease every renew interval while
// denying the wake fast path entirely, so releasing is cheaper AND correct. A
// group that actually advanced (processed > 0) keeps its lease and reschedules
// immediately, so active backlog draining is never churned.
function shouldYieldIdleProjectionGroupLease(runner: WorkerRunner, result?: ProjectorRunResult): boolean {
  return runner.kind === "projection-group" && result !== undefined && result.processed === 0;
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

export function createWorkerRunnerLeaseName(runner: Pick<WorkerRunner, "kind" | "name" | "leaseName">): string {
  return runner.leaseName ?? `${runner.kind}:${runner.name}`;
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
    refreshPriority: async () => {
      // Re-read the live source head for every subscription so
      // `group.getStatus().outstandingEventCount` (this runner's priority)
      // reflects backlog that accrued while the group sat idle. Read-only,
      // mirroring `refreshProjectionGroupStatuses`; never runs a projection.
      await group.refreshStatus();
      for (const subscriptionRunner of group.subscriptionRunners) {
        await subscriptionRunner.refreshStatus();
      }
    },
    projectionStatusSnapshot: () => group.getStatus(),
    runOnce: async (context) => {
      const runContext: ProjectionRunContext = {
        ...context,
        idleInTransactionSessionTimeoutMs:
          context?.idleInTransactionSessionTimeoutMs ?? idleInTransactionSessionTimeoutMs,
      };
      try {
        runContext.throwIfLeaseLost?.();
        const refreshedStatus = await group.refreshStatus();
        const status = { ...refreshedStatus, recoveryRequired: group.getStatus().recoveryRequired };
        if (status.revisionStale && revisionStaleBehavior === "reject") {
          throw new ProjectionGroupRevisionStaleError(group);
        }
        if (status.recoveryRequired || (status.revisionStale && rebuildingRevision !== group.projectionRevision)) {
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

type ProjectionOperationRunnerOptions = Readonly<{
  controlPlane: PlatformControlPlane;
  claimTtlMs: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  idleInTransactionSessionTimeoutMs: number;
  statementTimeoutMs: number;
  cancelPollIntervalMs: number;
  operationTimeoutMs: number;
  rebuildOperationTimeoutMs: number;
  maxAttempts: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  leaseAcquireTimeoutMs: number;
  leaseAcquireRetryIntervalMs: number;
  onCheckpointsReset?: (checkpointKeys: readonly string[]) => Promise<void>;
  observer?: WorkerRuntimeObserver;
}>;

function createProjectionOperationWorkerRunner(
  runtime: WorkerHostRuntime,
  options: ProjectionOperationRunnerOptions,
  runnerName = "projection-operations",
): WorkerRunner {
  return {
    name: runnerName,
    kind: "job",
    priority: () => 0,
    runOnce: async (context) => {
      const ownerId = context?.ownerId ?? "projection-operation-worker";
      const operation = await options.controlPlane.claimProjectionOperation({
        ownerId,
        claimTtlMs: options.claimTtlMs,
        maxAttempts: options.maxAttempts,
        retryBackoffBaseMs: options.retryBackoffBaseMs,
        retryBackoffMaxMs: options.retryBackoffMaxMs,
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
        const latestOperation = await options.controlPlane
          .getProjectionOperation(operation.operationId)
          .catch(() => null);
        if (latestOperation?.state === "cancel_requested") {
          const cancelled = await options.controlPlane
            .completeProjectionOperation({
              operationId: operation.operationId,
              ownerId,
              fencingToken: operation.claimFencingToken,
              result: {
                state: "cancelled",
                message: error instanceof Error ? error.message : String(error),
              },
            })
            .catch(() => false);
          if (cancelled) {
            options.observer?.projectionOperationCompleted?.(
              projectionOperationEvent({ ...operation, state: "cancelled" }, ownerId, operation.claimFencingToken),
            );
            return {
              processed: 1,
              lastGlobalPosition: ZERO_GLOBAL_POSITION,
              state: "degraded",
            };
          }
          throw error;
        }

        // Lease contention is transient (the group runner yields its lease
        // between idle passes) and an execution-deadline timeout is a symptom
        // of a slow-but-progressing pass (a large blocked stream, momentary DB
        // slowness), not a poison payload: both requeue with backoff so the
        // charged attempt budget bounds them and the dead-letter sweep
        // quarantines a persistently-hung operation once its attempts are
        // exhausted. Making a timeout retryable is what actually unpins the
        // executor in flight — a hung operation aborts at its deadline, frees
        // its claim + the shared projection-group lease, and lets younger
        // operations and the scheduled group runner proceed while it backs off
        // (issue #4611). Every other failure is terminal.
        const retryable =
          (error instanceof ProjectionRunnerLeaseUnavailableError ||
            error instanceof ProjectionOperationTimedOutError) &&
          operation.attemptCount < options.maxAttempts;
        // The failure write is best-effort: if the claim was already lost
        // (expired TTL, fencing race, worker restart) the write returns false
        // and the operation stays reclaimable — its attempt was charged at
        // claim time, so the backoff horizon and attempt cap still bound it.
        // Never let a lost failure write mask the original error (issue
        // #4496: masked claim-loss failures left operations pinned in
        // `running` with no recorded error).
        const recorded = await options.controlPlane
          .failProjectionOperation({
            operationId: operation.operationId,
            ownerId,
            fencingToken: operation.claimFencingToken,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
            retryable,
            retryBackoffBaseMs: options.retryBackoffBaseMs,
            retryBackoffMaxMs: options.retryBackoffMaxMs,
          })
          .catch(() => false);
        options.observer?.projectionOperationFailed?.({
          ...projectionOperationEvent(
            { ...operation, state: recorded && retryable ? "queued" : "failed" },
            ownerId,
            operation.claimFencingToken,
          ),
          error,
        });
        throw error;
      }
    },
  };
}

async function runProjectionOperationWithRenewedClaim(
  runtime: WorkerHostRuntime,
  options: ProjectionOperationRunnerOptions,
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

  // Execution deadline: without one, a hung operation renews its claim
  // forever and pins its executor runner — the exact single-consumer jam from
  // issue #4496 (one operation `running` for hours while the queue backed
  // up). On timeout the claim stops renewing, the run context aborts, and the
  // still-valid claim records the timeout as the operation's failure.
  const operationTimeoutMs =
    operation.operationKind === "rebuild-projection-group" || operation.operationKind === "rebuild-context"
      ? options.rebuildOperationTimeoutMs
      : options.operationTimeoutMs;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const workPromise = runProjectionOperation(runtime, options, operation, ownerId, operationContext);
    // If the deadline wins the race, the leaked work promise settles later
    // (or never); mark its eventual rejection as handled so a hung apply path
    // cannot crash the process.
    workPromise.catch(() => undefined);
    await Promise.race([
      workPromise,
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          claimActive = false;
          abortController.abort();
          reject(new ProjectionOperationTimedOutError(operation.operationId, operationTimeoutMs));
        }, operationTimeoutMs);
        timeoutTimer.unref?.();
      }),
    ]);
    throwIfOperationClaimLost();
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    clearInterval(renewalTimer);
    runnerContext?.signal?.removeEventListener("abort", abortFromParent);
    abortController.abort();
  }
}

async function runProjectionOperation(
  runtime: WorkerHostRuntime,
  options: ProjectionOperationRunnerOptions,
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
        acquireTimeoutMs: options.leaseAcquireTimeoutMs,
        acquireRetryIntervalMs: options.leaseAcquireRetryIntervalMs,
        idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs,
        statementTimeoutMs: options.statementTimeoutMs,
        signal: runnerContext?.signal,
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
          acquireTimeoutMs: options.leaseAcquireTimeoutMs,
          acquireRetryIntervalMs: options.leaseAcquireRetryIntervalMs,
          idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs,
          statementTimeoutMs: options.statementTimeoutMs,
          signal: runnerContext?.signal,
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
        acquireTimeoutMs: options.leaseAcquireTimeoutMs,
        acquireRetryIntervalMs: options.leaseAcquireRetryIntervalMs,
        idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs,
        statementTimeoutMs: options.statementTimeoutMs,
        signal: runnerContext?.signal,
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
  /**
   * How long to keep retrying lease acquisition before giving up. The
   * scheduled projection-group runner yields its lease between idle passes,
   * so a short acquisition window lets a queued operation win the lease
   * instead of failing instantly on momentary contention. Defaults to a
   * single attempt.
   */
  acquireTimeoutMs?: number;
  acquireRetryIntervalMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
  statementTimeoutMs?: number;
  /**
   * Upstream abort signal (e.g. the operation execution deadline). When it
   * fires the held lease stops renewing immediately instead of waiting for the
   * next `shouldAbort` poll, so a timed-out operation cannot keep the shared
   * projection-group lease alive against the scheduled runner (issue #4611).
   */
  signal?: AbortSignal;
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
    throw new ProjectionRunnerLeaseUnavailableError(input.leaseName);
  }

  return outcome.result;
}

export async function tryRunWithRenewedLease<T>(
  controlPlane: PlatformControlPlane,
  input: RunWithRenewedLeaseInput,
  work: (context: ProjectionRunContext) => Promise<T>,
): Promise<Readonly<{ acquired: true; result: T }> | Readonly<{ acquired: false }>> {
  const lease = await acquireLeaseWithinTimeout(controlPlane, input);
  if (!lease) {
    return { acquired: false };
  }

  let leaseActive = true;
  const abortController = new AbortController();
  // Chain the held lease off any upstream signal (the operation execution
  // deadline) so an in-flight abort stops lease renewal at once rather than up
  // to one `shouldAbort` poll interval later. Without this a timed-out
  // operation keeps renewing the shared `projection-group:<name>` lease while
  // its leaked work settles, starving the scheduled group runner (issue #4611).
  const abortFromUpstreamSignal = () => {
    leaseActive = false;
    abortController.abort();
  };
  if (input.signal?.aborted) {
    abortFromUpstreamSignal();
  } else {
    input.signal?.addEventListener("abort", abortFromUpstreamSignal, { once: true });
  }
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
    // Once the run is aborted (lease lost, cancellation, or operation
    // timeout) the lease must lapse by TTL rather than being renewed forever:
    // leaked work that ignores the abort signal must not pin the shared
    // projection-group lease against the scheduled runner.
    if (!leaseActive || abortController.signal.aborted) {
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
    input.signal?.removeEventListener("abort", abortFromUpstreamSignal);
    await controlPlane.releaseLease(lease);
  }
}

async function acquireLeaseWithinTimeout(
  controlPlane: PlatformControlPlane,
  input: RunWithRenewedLeaseInput,
): Promise<PlatformLease | null> {
  const acquireDeadline = Date.now() + Math.max(0, Math.floor(input.acquireTimeoutMs ?? 0));
  const retryIntervalMs = Math.max(50, Math.floor(input.acquireRetryIntervalMs ?? 500));

  for (;;) {
    const lease = await controlPlane.acquireLease({
      leaseName: input.leaseName,
      ownerId: input.ownerId,
      ttlMs: input.ttlMs,
      metadata: input.metadata,
    });
    if (lease) {
      return lease;
    }

    const remainingMs = acquireDeadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    if (input.shouldAbort && (await input.shouldAbort())) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, remainingMs)));
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
