import {
  composeWorkerJobs,
  type WorkerJobInput,
  type WorkerJobRegistry,
} from "@chase-sets/platform-runtime/worker-jobs";
import { workerContextRegistry } from "./context-registry";
import { createGoogleShoppingJobRunners } from "./google-shopping-job-runners";
import { createDeferredScheduledRunners, createInfrastructureScheduledRunners } from "./scheduled-runners";
import type { PlatformWorkerConfig } from "./config";
import type { ReconcileOrderPaymentBeforeDeadline } from "@chase-sets/ordering/server";
import type { PaymentsServices } from "@chase-sets/payments/server";

export function createOrderPaymentDeadlineWorkerPorts(services: WorkerJobInput<PlatformWorkerConfig>["services"]) {
  const payments = services.payments as PaymentsServices | undefined;
  return {
    reconcileOrderPaymentBeforeDeadline: payments?.payments?.reconcileOrderPaymentBeforeDeadline satisfies
      | ReconcileOrderPaymentBeforeDeadline
      | undefined,
  };
}

export function createPlatformWorkerJobComposition(
  input: WorkerJobInput<PlatformWorkerConfig>,
  retention: Pick<Parameters<typeof createInfrastructureScheduledRunners>[0], "workSignalCleanup" | "retentionSweep">,
  registry: WorkerJobRegistry<WorkerJobInput<PlatformWorkerConfig>> = workerContextRegistry,
) {
  const active = input.config.runtimeProfile !== "landing";
  const jobs = composeWorkerJobs(
    registry,
    { ...input, ports: { ...input.ports, ...createOrderPaymentDeadlineWorkerPorts(input.services) } },
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
