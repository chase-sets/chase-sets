import "./observability-prelude";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  collectWorkerRunners,
  createWorkerHost,
  createWorkerRunnerLoop,
} from "@chase-sets/platform-runtime/worker";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { getObservabilityRuntime } from "@chase-sets/observability";
import { loadConfig } from "./config";
import {
  closeAdminSupportWorkerPools,
  createAdminSupportWorkerPools,
} from "./database-pools";
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
const runners = collectWorkerRunners(runtime);
const runnerLoop = createWorkerRunnerLoop({
  workerId: config.workerId,
  controlPlane,
  runners,
  maxConcurrentRunners: config.maxConcurrentRunners,
  leaseTtlMs: config.leaseTtlMs,
  leaseRenewIntervalMs: config.leaseRenewIntervalMs,
  pollIntervalMs: config.pollIntervalMs,
  onError: (error, runner) => {
    logger.error("Admin support worker runner failed.", {
      type: "admin-support-worker.runner.failed",
      runner: runner.name,
      runnerKind: runner.kind,
      error,
    });
  },
});

await controlPlane.heartbeatWorker({
  workerId: config.workerId,
  workerKind: "admin-support-worker",
  metadata: { runnerCount: runners.length },
});
const heartbeatTimer = setInterval(() => {
  void controlPlane.heartbeatWorker({
    workerId: config.workerId,
    workerKind: "admin-support-worker",
    metadata: { runnerCount: runners.length },
  });
}, Math.max(5_000, Math.floor(config.leaseTtlMs / 3)));
heartbeatTimer.unref?.();
runnerLoop.start();

const app = new Hono();
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", async (c) => {
  await pools.control.query("SELECT 1");
  return c.json({ status: "ok" });
});
app.get("/internal/workers/status", async (c) =>
  c.json({
    status: "ok",
    loop: runnerLoop.status(),
    workers: await controlPlane.listWorkerHeartbeats(),
    runners: await controlPlane.listRunnerStatuses(),
    leases: await controlPlane.listLeases(),
  }),
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("Admin support worker listening.", {
    type: "admin-support-worker.started",
    port: info.port,
    workerId: config.workerId,
    runnerCount: runners.length,
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(heartbeatTimer);
    void runnerLoop.stop()
      .finally(() => closeAdminSupportWorkerPools(pools))
      .finally(() => observability.shutdown())
      .finally(() => process.exit(0));
  });
}
