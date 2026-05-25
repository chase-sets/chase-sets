import {
  collectProjectors,
  resetProjectionGroup,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  sortSubscriptionRunners,
  type ContextProjectionGroup,
  type ContextProjectionGroupStatus,
  type ContextSubscriptionRunner,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import type { BcApiModule, BcHostPort, BcProjector } from "@chase-sets/bounded-context-module";
import type { ProjectionRunContext, ProjectorRunResult } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PlatformControlPlane, PlatformLease } from "./control-plane";

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
  projectors: ReturnType<typeof collectProjectors>;
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

type WorkerRunnerLoopOptions = Readonly<{
  workerId: string;
  controlPlane: PlatformControlPlane;
  runners: readonly WorkerRunner[];
  maxConcurrentRunners: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  pollIntervalMs: number;
  onError?: (error: unknown, runner: WorkerRunner) => void;
}>;

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
        entry.module.createServices(pool, getHostPortsForContext(entry.manifest, options.hostPorts ?? {}) as never),
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
      projectors: entry.module.projectors(contextServices as never),
    };
  });
  const subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
  const projectionGroups = resolveModuleProjectionGroups(mountedContexts, subscriptionRunners);

  return {
    mountedContexts,
    services,
    projectors: collectProjectors(
      mountedContexts.map((entry) => ({
        projectors: entry.projectors,
      })),
    ),
    projectionGroups,
    subscriptionRunners,
  };
}

export function collectWorkerRunners(runtime: WorkerHostRuntime): readonly WorkerRunner[] {
  return [
    ...runtime.mountedContexts.flatMap((entry) =>
      entry.projectors.map((projector, index) => createProjectorRunner(entry.contextName, projector, index)),
    ),
    ...runtime.projectionGroups.map(createProjectionGroupWorkerRunner),
  ];
}

export function createWorkerRunnerLoop(options: WorkerRunnerLoopOptions): WorkerRunnerLoop {
  const active = new Set<Promise<void>>();
  const activeRunnerNames = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunnerIndex = 0;
  let leaseMissCount = 0;

  const schedule = () => {
    if (stopped) {
      return;
    }

    for (
      let attempts = 0;
      attempts < options.runners.length && active.size < options.maxConcurrentRunners;
      attempts += 1
    ) {
      const selection = selectNextRunner(options.runners, activeRunnerNames, nextRunnerIndex);
      if (!selection) {
        break;
      }
      const { runner, index } = selection;
      nextRunnerIndex = (index + 1) % options.runners.length;

      const promise = runLeasedRunner(options, runner)
        .then((leaseAcquired) => {
          if (!leaseAcquired) {
            leaseMissCount += 1;
          }
        })
        .catch((error) => options.onError?.(error, runner))
        .finally(() => {
          active.delete(promise);
          activeRunnerNames.delete(runner.name);
        });
      active.add(promise);
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
  startIndex: number,
): Readonly<{ runner: WorkerRunner; index: number }> | null {
  let fallback: Readonly<{ runner: WorkerRunner; index: number }> | null = null;

  for (let offset = 0; offset < runners.length; offset += 1) {
    const index = (startIndex + offset) % runners.length;
    const runner = runners[index];
    if (activeRunnerNames.has(runner.name)) {
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

async function runLeasedRunner(options: WorkerRunnerLoopOptions, runner: WorkerRunner): Promise<boolean> {
  const leaseName = `${runner.kind}:${runner.name}`;
  const lease = await options.controlPlane.acquireLease({
    leaseName,
    ownerId: options.workerId,
    ttlMs: options.leaseTtlMs,
    metadata: { runnerKind: runner.kind },
  });
  if (!lease) {
    return false;
  }

  let leaseActive = true;
  const abortController = new AbortController();
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
          abortController.abort();
        }
      })
      .catch(() => {
        leaseActive = false;
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
    clearInterval(renewalTimer);
    await options.controlPlane.releaseLease(lease);
  }

  return true;
}

function createProjectorRunner(contextName: string, projector: BcProjector, index: number): WorkerRunner {
  return {
    name: `${contextName}.${projector.projectorName ?? `projector-${index + 1}`}`,
    kind: "projector",
    runOnce: (context) => projector.runOnce(context),
  };
}

function createProjectionGroupWorkerRunner(group: ContextProjectionGroup): WorkerRunner {
  let rebuildingRevision: number | null = null;

  return {
    name: `${group.targetContextName}.${group.projectionName}`,
    kind: "projection-group",
    priority: () => BigInt(group.getStatus().outstandingEventCount),
    projectionStatusSnapshot: () => group.getStatus(),
    runOnce: async (context) => {
      try {
        context?.throwIfLeaseLost?.();
        const status = await group.refreshStatus();
        if (status.revisionStale && rebuildingRevision !== group.projectionRevision) {
          context?.throwIfLeaseLost?.();
          await resetProjectionGroup(group);
          rebuildingRevision = group.projectionRevision;
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
