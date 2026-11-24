import { composeWorkerJobs } from "@chase-sets/platform-runtime/worker-jobs";
import { workerContextRegistry } from "../src/context-registry";
import {
  createDeferredScheduledRunners,
  createInfrastructureScheduledRunners,
  type RegisteredScheduledRunnerConfig,
} from "../src/scheduled-runners";
import type { PlatformWorkerConfig } from "../src/config";
import { createOrderPaymentDeadlineWorkerPorts } from "../src/worker-job-composition";

export function createRegisteredScheduledRunners(
  input: Parameters<typeof createInfrastructureScheduledRunners>[0] &
    Readonly<{ config: RegisteredScheduledRunnerConfig }>,
) {
  const registry = workerContextRegistry.map((entry) => ({
    ...entry,
    manifest: {
      scheduledJobs: ("scheduledJobs" in entry.manifest ? entry.manifest.scheduledJobs : []).filter(
        (job) => job.group === "scheduled" && job.order < 200,
      ),
    },
  }));
  return composeWorkerJobs(
    registry,
    {
      ...input,
      config: input.config as PlatformWorkerConfig,
      logger: { ...input.logger, error: input.logger.warn },
      ports: createOrderPaymentDeadlineWorkerPorts(input.services),
      runtime: { services: input.services, mountedContexts: [], projectionGroups: [], subscriptionRunners: [] },
    },
    "proof",
    [
      { order: 126, group: "scheduled", create: () => createDeferredScheduledRunners(input) },
      { order: 190, group: "scheduled", create: () => createInfrastructureScheduledRunners(input) },
    ],
  ).scheduled;
}
