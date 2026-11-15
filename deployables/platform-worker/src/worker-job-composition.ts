import {
  composeWorkerJobs,
  type WorkerJobInput,
  type WorkerJobRegistry,
} from "@chase-sets/platform-runtime/worker-jobs";
import { workerContextRegistry } from "./context-registry";
import { createGoogleShoppingJobRunners } from "./google-shopping-job-runners";
import { createDeferredScheduledRunners, createInfrastructureScheduledRunners } from "./scheduled-runners";
import type { PlatformWorkerConfig } from "./config";
export function createPlatformWorkerJobComposition(
  input: WorkerJobInput<PlatformWorkerConfig>,
  retention: Pick<Parameters<typeof createInfrastructureScheduledRunners>[0], "workSignalCleanup" | "retentionSweep">,
  registry: WorkerJobRegistry<WorkerJobInput<PlatformWorkerConfig>> = workerContextRegistry,
) {
  const active = input.config.runtimeProfile !== "landing";
  const jobs = composeWorkerJobs(
    registry,
    input,
    input.config.runtimeProfile,
    active
      ? [
          {
            order: 20,
            group: "jobs",
            create: () => createGoogleShoppingJobRunners(input.services, input.config, input.logger),
          },
          { order: 126, group: "scheduled", create: () => createDeferredScheduledRunners(input) },
          {
            order: 190,
            group: "scheduled",
            create: () => createInfrastructureScheduledRunners({ ...input, ...retention }),
          },
        ]
      : [],
  );
  input.logger.info("Worker registry jobs composed.", {
    type: "worker.registry-jobs",
    runtimeProfile: input.config.runtimeProfile,
    jobs: Object.entries(jobs).map(([group, runners]) => ({ group, names: runners.map((runner) => runner.name) })),
  });
  return jobs;
}
