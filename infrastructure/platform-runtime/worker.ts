import {
  collectProjectors,
  resetProjectionGroup,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  type ContextProjectionGroup,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import type { BcApiModule, BcHostPort, BcProjector } from "@chase-sets/bounded-context-module";
import type { ProjectorRunResult } from "@chase-sets/event-core/projector";
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
  runOnce: () => Promise<ProjectorRunResult>;
}>;

export type WorkerRunnerLoop = Readonly<{
  start: () => void;
  stop: () => Promise<void>;
  status: () => Readonly<{
    workerId: string;
    activeRunnerCount: number;
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

  const schedule = () => {
    if (stopped) {
      return;
    }

    for (
      let inspected = 0;
      inspected < options.runners.length && active.size < options.maxConcurrentRunners;
      inspected += 1
    ) {
      const runner = options.runners[nextRunnerIndex];
      nextRunnerIndex = (nextRunnerIndex + 1) % options.runners.length;

      if (activeRunnerNames.has(runner.name)) {
        continue;
      }

      const promise = runLeasedRunner(options, runner)
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
      stopped,
    }),
  };
}

async function runLeasedRunner(options: WorkerRunnerLoopOptions, runner: WorkerRunner): Promise<void> {
  const leaseName = `${runner.kind}:${runner.name}`;
  const lease = await options.controlPlane.acquireLease({
    leaseName,
    ownerId: options.workerId,
    ttlMs: options.leaseTtlMs,
    metadata: { runnerKind: runner.kind },
  });
  if (!lease) {
    await options.controlPlane.recordRunnerStatus({
      runnerName: runner.name,
      runnerKind: runner.kind,
      state: "skipped",
    });
    return;
  }

  let leaseActive = true;
  const renewalTimer = setInterval(() => {
    void options.controlPlane
      .renewLease(lease, options.leaseTtlMs)
      .then((renewed) => {
        leaseActive = leaseActive && renewed;
      })
      .catch(() => {
        leaseActive = false;
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

    if (!leaseActive) {
      throw new Error(`Lost lease '${lease.leaseName}'.`);
    }

    const result = await runner.runOnce();

    await options.controlPlane.recordRunnerStatus({
      runnerName: runner.name,
      runnerKind: runner.kind,
      state: result.processed > 0 ? "running" : "caught-up",
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      lastProcessed: result.processed,
    });
  } catch (error) {
    await options.controlPlane.recordRunnerStatus({
      runnerName: runner.name,
      runnerKind: runner.kind,
      state: "error",
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearInterval(renewalTimer);
    await options.controlPlane.releaseLease(lease);
  }
}

function createProjectorRunner(contextName: string, projector: BcProjector, index: number): WorkerRunner {
  return {
    name: `${contextName}.${projector.projectorName ?? `projector-${index + 1}`}`,
    kind: "projector",
    runOnce: projector.runOnce,
  };
}

function createProjectionGroupWorkerRunner(group: ContextProjectionGroup): WorkerRunner {
  let rebuildingRevision: number | null = null;

  return {
    name: `${group.targetContextName}.${group.projectionName}`,
    kind: "projection-group",
    runOnce: async () => {
      try {
        const status = await group.refreshStatus();
        if (status.revisionStale && rebuildingRevision !== group.projectionRevision) {
          await resetProjectionGroup(group);
          rebuildingRevision = group.projectionRevision;
        }

        let processed = 0;
        let lastGlobalPosition = ZERO_GLOBAL_POSITION;

        for (const runner of group.subscriptionRunners) {
          const result = await runner.runOnce();
          processed += result.processed;
          lastGlobalPosition = result.lastGlobalPosition;
        }

        if (processed === 0) {
          await group.markRevisionSynced();
          rebuildingRevision = null;
        }

        return {
          processed,
          lastGlobalPosition,
        };
      } catch (error) {
        rebuildingRevision = null;
        throw error;
      }
    },
  };
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
