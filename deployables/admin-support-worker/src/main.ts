import "./observability-prelude";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  collectWorkerRunners,
  createWorkerHost,
  createWorkerRunnerLoop,
  type WorkerRunner,
  type WorkerRunnerLoop,
} from "@chase-sets/platform-runtime/worker";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { getObservabilityRuntime } from "@chase-sets/observability";
import { loadConfig } from "./config";
import { closeAdminSupportWorkerPools, createAdminSupportWorkerPools } from "./database-pools";
import { workerContextRegistry } from "./generated/worker-context-registry";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createAdminSupportWorkerPools(config);
await bootstrapPlatformControlPlane(pools.control);
const controlPlane = createPostgresPlatformControlPlane(pools.control);
const runtime = createWorkerHost(workerContextRegistry, "admin-support-worker", {
  pools,
});
const projectionRunners = collectWorkerRunners(runtime);
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

await controlPlane.heartbeatWorker({
  workerId: config.workerId,
  workerKind: "admin-support-worker",
  metadata: { runnerCount, runnerGroups: runnerGroupMetadata(runnerGroups) },
});
const heartbeatTimer = setInterval(
  () => {
    void controlPlane
      .heartbeatWorker({
        workerId: config.workerId,
        workerKind: "admin-support-worker",
        metadata: { runnerCount, runnerGroups: runnerGroupMetadata(runnerGroups) },
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

const app = new Hono();
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", async (c) => {
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
    loops: loopStatuses,
    workers: await controlPlane.listWorkerHeartbeats(),
    runners: await controlPlane.listRunnerStatuses(),
    leases: await controlPlane.listLeases(),
  });
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("Admin support worker listening.", {
    type: "admin-support-worker.started",
    port: info.port,
    workerId: config.workerId,
    runnerCount,
    runnerGroups: runnerGroupMetadata(runnerGroups),
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(heartbeatTimer);
    void stopRunnerLoops(runnerLoops.map((runnerLoop) => runnerLoop.loop))
      .finally(() => closeAdminSupportWorkerPools(pools))
      .finally(() => observability.shutdown())
      .finally(() => process.exit(0));
  });
}

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

function createCatalogBulkJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<ReturnType<typeof loadConfig>, "workerId" | "leaseTtlMs">,
): readonly WorkerRunner[] {
  const catalog = services.catalog as
    | {
        sourceObservations?: {
          processNextBulkReviewJob?: (input: { claimOwnerId: string; claimTtlMs: number }) => Promise<number>;
          processNextIntegrationJob?: (input: { claimOwnerId: string; claimTtlMs: number }) => Promise<number>;
        };
      }
    | undefined;
  const processNextBulkReviewJob = catalog?.sourceObservations?.processNextBulkReviewJob;
  const processNextIntegrationJob = catalog?.sourceObservations?.processNextIntegrationJob;

  if (!processNextBulkReviewJob && !processNextIntegrationJob) {
    return [];
  }

  const runners: WorkerRunner[] = [];

  if (processNextBulkReviewJob) {
    runners.push({
      name: "catalog.source-observation-bulk-jobs",
      kind: "job",
      runOnce: async () => ({
        processed: await processNextBulkReviewJob({
          claimOwnerId: input.workerId,
          claimTtlMs: input.leaseTtlMs * 4,
        }),
        lastGlobalPosition: "0" as never,
      }),
    });
  }

  if (processNextIntegrationJob) {
    runners.push({
      name: "catalog.source-observation-integration-jobs",
      kind: "job",
      runOnce: async () => ({
        processed: await processNextIntegrationJob({
          claimOwnerId: input.workerId,
          claimTtlMs: input.leaseTtlMs * 4,
        }),
        lastGlobalPosition: "0" as never,
      }),
    });
  }

  return runners;
}
