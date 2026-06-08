import "./observability-prelude";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  collectWorkerRunners,
  createWorkerHost,
  createWorkerRunnerLoop,
  type WorkerRuntimeObserver,
  type WorkerRunner,
  type WorkerRunnerLoop,
} from "@chase-sets/platform-runtime/worker";
import { assertRunnerCapacity, summarizeRunnerCapacity } from "@chase-sets/platform-runtime/worker-capacity";
import { createFilesystemObjectStorage, createS3ObjectStorage, type ObjectStorage } from "@chase-sets/object-storage";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createProcessDrainState, startGracefulHttpServer } from "@chase-sets/platform-runtime/process-lifecycle";
import {
  getObservabilityRuntime,
  recordCatalogIntegrationJob,
  recordCatalogIntegrationOptionQuery,
} from "@chase-sets/observability";
import { loadConfig, type AdminSupportWorkerCatalogAssetStorageConfig } from "./config";
import { closeAdminSupportWorkerPools, createAdminSupportWorkerPools } from "./database-pools";
import { workerContextRegistry } from "./generated/worker-context-registry";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createAdminSupportWorkerPools(config);
await bootstrapPlatformControlPlane(pools.control);
const controlPlane = createPostgresPlatformControlPlane(pools.control);
const catalogAssetStorage = createCatalogAssetStorage(config.catalogAssetStorage);
const sourceObservationTelemetry = createSourceObservationTelemetry();
const runtime = createWorkerHost(workerContextRegistry, "admin-support-worker", {
  pools,
  hostPorts: {
    catalogAssetStorage,
    sourceObservationTelemetry,
  },
});
const projectionRunners = collectWorkerRunners(runtime, {
  controlPlane,
  projectionOperationClaimTtlMs: config.leaseTtlMs * 4,
  projectionOperationLeaseTtlMs: config.leaseTtlMs,
  projectionOperationLeaseRenewIntervalMs: config.leaseRenewIntervalMs,
  observer: createWorkerObserver("admin-support-worker"),
});
const bulkJobRunners = createCatalogBulkJobRunners(runtime.services, config);
const runnerGroups = [
  createRunnerGroup("projections", projectionRunners, config.projectionMaxConcurrentRunners),
  createRunnerGroup("jobs", bulkJobRunners, config.jobMaxConcurrentRunners),
].filter((group) => group.runners.length > 0);
const runnerLoops = runnerGroups.map((group) => ({
  ...group,
  loop: createWorkerRunnerLoop({
    workerId: config.workerId,
    controlPlane,
    runners: group.runners,
    maxConcurrentRunners: group.maxConcurrentRunners,
    leaseTtlMs: config.leaseTtlMs,
    leaseRenewIntervalMs: config.leaseRenewIntervalMs,
    pollIntervalMs: config.pollIntervalMs,
    observer: createWorkerObserver("admin-support-worker", group.name),
    onError: (error, runner) => {
      logger.error("Admin support worker runner failed.", {
        type: "admin-support-worker.runner.failed",
        runnerGroup: group.name,
        runner: runner.name,
        runnerKind: runner.kind,
        error,
      });
    },
  }),
}));
const runnerCount = runnerGroups.reduce((total, group) => total + group.runners.length, 0);
const runnerCapacity = summarizeRunnerCapacity(config.pool.max, runnerGroupCapacityInputs(runnerGroups));
assertRunnerCapacity(runnerCapacity, {
  workerName: "Admin support worker",
  allowOverPoolCapacity: process.env.ALLOW_WORKER_OVER_POOL_CAPACITY === "true",
});

await controlPlane.heartbeatWorker({
  workerId: config.workerId,
  workerKind: "admin-support-worker",
  metadata: { runnerCount, runnerGroups: runnerGroupMetadata(runnerGroups), runnerCapacity },
});
const heartbeatTimer = setInterval(
  () => {
    void controlPlane
      .heartbeatWorker({
        workerId: config.workerId,
        workerKind: "admin-support-worker",
        metadata: { runnerCount, runnerGroups: runnerGroupMetadata(runnerGroups), runnerCapacity },
      })
      .catch((error) => {
        logger.error("Admin support worker heartbeat failed.", {
          type: "admin-support-worker.heartbeat.failed",
          error,
        });
      });
  },
  Math.max(5_000, Math.floor(config.leaseTtlMs / 3)),
);
heartbeatTimer.unref?.();
for (const runnerLoop of runnerLoops) {
  runnerLoop.loop.start();
}

const drainState = createProcessDrainState();
const app = new Hono();
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", async (c) => {
  if (drainState.isDraining()) {
    return c.json(
      {
        status: "degraded",
        checks: [
          {
            name: "process.draining",
            status: "degraded",
            message: "Process is draining for shutdown.",
          },
        ],
      },
      503,
    );
  }

  await pools.control.query("SELECT 1");
  return c.json({ status: "ok" });
});
app.get("/internal/workers/status", async (c) => {
  const loopStatuses = runnerLoops.map((runnerLoop) => ({
    name: runnerLoop.name,
    maxConcurrentRunners: runnerLoop.maxConcurrentRunners,
    runnerCount: runnerLoop.runners.length,
    ...runnerLoop.loop.status(),
  }));
  return c.json({
    status: "ok",
    loop: summarizeLoopStatuses(config.workerId, loopStatuses),
    capacity: runnerCapacity,
    loops: loopStatuses,
    workers: await controlPlane.listWorkerHeartbeats(),
    runners: await controlPlane.listRunnerStatuses(),
    leases: await controlPlane.listLeases(),
  });
});

startGracefulHttpServer({
  name: "admin-support-worker",
  port: config.port,
  serve,
  fetch: app.fetch,
  drainState,
  logger,
  onListening: (info) => {
    logger.info("Admin support worker listening.", {
      type: "admin-support-worker.started",
      port: info.port,
      workerId: config.workerId,
      runnerCount,
      runnerGroups: runnerGroupMetadata(runnerGroups),
      runnerCapacity,
    });
  },
  onDrainStart: [
    async () => {
      clearInterval(heartbeatTimer);
      await stopRunnerLoops(runnerLoops.map((runnerLoop) => runnerLoop.loop));
    },
  ],
  onShutdown: [async () => closeAdminSupportWorkerPools(pools), async () => observability.shutdown()],
});

type RunnerGroup = Readonly<{
  name: string;
  runners: readonly WorkerRunner[];
  maxConcurrentRunners: number;
}>;

function createRunnerGroup(name: string, runners: readonly WorkerRunner[], maxConcurrentRunners: number): RunnerGroup {
  return {
    name,
    runners,
    maxConcurrentRunners,
  };
}

function runnerGroupMetadata(groups: readonly RunnerGroup[]) {
  return Object.fromEntries(
    groups.map((group) => [
      group.name,
      {
        runnerCount: group.runners.length,
        maxConcurrentRunners: group.maxConcurrentRunners,
      },
    ]),
  );
}

function runnerGroupCapacityInputs(groups: readonly RunnerGroup[]) {
  return groups.map((group) => ({
    name: group.name,
    runnerCount: group.runners.length,
    maxConcurrentRunners: group.maxConcurrentRunners,
  }));
}

function summarizeLoopStatuses(workerId: string, loopStatuses: readonly ReturnType<WorkerRunnerLoop["status"]>[]) {
  return {
    workerId,
    activeRunnerCount: loopStatuses.reduce((total, status) => total + status.activeRunnerCount, 0),
    stopped: loopStatuses.every((status) => status.stopped),
  };
}

async function stopRunnerLoops(loops: readonly WorkerRunnerLoop[]) {
  await Promise.allSettled(loops.map((loop) => loop.stop()));
}

function createWorkerObserver(workerKind: string, runnerGroup?: string): WorkerRuntimeObserver {
  return {
    leaseMissed: (event) =>
      logger.info("Worker runner lease missed.", {
        type: "worker.runner.lease_missed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    leaseRenewFailed: (event) =>
      logger.warn("Worker runner lease renewal failed.", {
        type: "worker.runner.lease_renew_failed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    runnerCompleted: (event) =>
      logger.info("Worker runner completed.", {
        type: "worker.runner.completed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    runnerFailed: (event) =>
      logger.error("Worker runner failed.", {
        type: "worker.runner.failed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    projectionOperationStarted: (event) =>
      logger.info("Projection operation started.", {
        type: "projection.operation.started",
        workerKind,
        runnerGroup,
        ...event,
      }),
    projectionOperationCompleted: (event) =>
      logger.info("Projection operation completed.", {
        type: "projection.operation.completed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    projectionOperationFailed: (event) =>
      logger.error("Projection operation failed.", {
        type: "projection.operation.failed",
        workerKind,
        runnerGroup,
        ...event,
      }),
  };
}

function createCatalogBulkJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<ReturnType<typeof loadConfig>, "workerId" | "leaseTtlMs">,
): readonly WorkerRunner[] {
  type CatalogSourceObservationJobProcessor = Readonly<{
    processNextBulkReviewJob?: (input: {
      claimOwnerId: string;
      claimTtlMs: number;
      signal?: AbortSignal;
      throwIfLeaseLost?: () => void;
    }) => Promise<number>;
    processNextIntegrationJob?: (input: {
      claimOwnerId: string;
      claimTtlMs: number;
      signal?: AbortSignal;
      throwIfLeaseLost?: () => void;
    }) => Promise<number>;
  }>;

  const catalog = services.catalog as
    | {
        sourceObservations?: CatalogSourceObservationJobProcessor;
        authoringBulkJobs?: {
          processNext?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            services: never;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<boolean>;
        };
      }
    | undefined;
  const processNextBulkReviewJob = catalog?.sourceObservations?.processNextBulkReviewJob;
  const processNextIntegrationJob = catalog?.sourceObservations?.processNextIntegrationJob;
  const processNextAuthoringBulkJob = catalog?.authoringBulkJobs?.processNext;

  if (!processNextBulkReviewJob && !processNextIntegrationJob && !processNextAuthoringBulkJob) {
    return [];
  }

  const runners: WorkerRunner[] = [];

  if (processNextBulkReviewJob) {
    runners.push({
      name: "catalog.source-observation-bulk-jobs",
      kind: "job",
      runOnce: async (context) => ({
        processed: await processNextBulkReviewJob({
          claimOwnerId: input.workerId,
          claimTtlMs: input.leaseTtlMs * 4,
          signal: context?.signal,
          throwIfLeaseLost: context?.throwIfLeaseLost,
        }),
        lastGlobalPosition: "0" as never,
      }),
    });
  }

  if (processNextIntegrationJob) {
    runners.push({
      name: "catalog.source-observation-integration-jobs",
      kind: "job",
      runOnce: async (context) => ({
        processed: await processNextIntegrationJob({
          claimOwnerId: input.workerId,
          claimTtlMs: input.leaseTtlMs * 4,
          signal: context?.signal,
          throwIfLeaseLost: context?.throwIfLeaseLost,
        }),
        lastGlobalPosition: "0" as never,
      }),
    });
  }

  if (processNextAuthoringBulkJob && catalog) {
    runners.push({
      name: "catalog.authoring-bulk-jobs",
      kind: "job",
      runOnce: async (context) => ({
        processed: (await processNextAuthoringBulkJob({
          claimOwnerId: input.workerId,
          claimTtlMs: input.leaseTtlMs * 4,
          services: catalog as never,
          signal: context?.signal,
          throwIfLeaseLost: context?.throwIfLeaseLost,
        }))
          ? 1
          : 0,
        lastGlobalPosition: "0" as never,
      }),
    });
  }

  return runners;
}

function createCatalogAssetStorage(storageConfig: AdminSupportWorkerCatalogAssetStorageConfig): ObjectStorage {
  return storageConfig.kind === "s3"
    ? createS3ObjectStorage(storageConfig)
    : createFilesystemObjectStorage(storageConfig);
}

function createSourceObservationTelemetry() {
  return {
    recordProviderOptionQuery: recordCatalogIntegrationOptionQuery,
    recordIntegrationJob: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "integration-job" }),
    recordBulkReviewWorkUnit: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "bulk-review-work-unit" }),
  };
}
