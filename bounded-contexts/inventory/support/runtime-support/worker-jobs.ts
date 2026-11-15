import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import { createDurableJobLaneRunners } from "@chase-sets/platform-runtime/worker";
import {
  createScheduledJobRunner,
  type WorkerJobInput,
  type WorkerJobLogger,
} from "@chase-sets/platform-runtime/worker-jobs";
import type { InventoryServices } from "./services";
export type InventoryJobRunnerConfig = CreateInventoryJobRunnersConfig;

export function createInventoryProductResolutionMaintenanceRunners(
  services: Readonly<Record<string, unknown>>,
  config: Readonly<{ workerId: string; leaseTtlMs: number }>,
): readonly WorkerRunner[] {
  const inventory = services.inventory as InventoryServices | undefined;
  const processNext = inventory?.importBatches?.processNextImportProductResolutionMaintenanceJob;
  if (!processNext) return [];
  return createDurableJobLaneRunners({
    workflowName: "inventory.import-product-resolution-maintenance",
    laneCount: 1,
    runLane: async (lane) => ({
      processed: await processNext({
        claimOwnerId: `${config.workerId}:product-resolution-maintenance`,
        claimTtlMs: config.leaseTtlMs * 4,
        signal: lane.runnerContext?.signal,
        throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
      }),
      lastGlobalPosition: "0" as never,
    }),
  });
}
type CreateInventoryJobRunnersConfig = Readonly<{
  inventoryImportBatchJobLaneCount: number;
  workerId: string;
  leaseTtlMs: number;
  inventoryImportBatchJobWorkflowMaxActiveClaims: number;
  inventoryImportBatchJobMaxActiveClaimsPerJob: number;
}>;
export function createInventoryJobRunners({
  services,
  config: input,
  logger,
}: Pick<WorkerJobInput<CreateInventoryJobRunnersConfig>, "services" | "config"> &
  Readonly<{ logger: Pick<WorkerJobLogger, "warn" | "error"> }>): readonly WorkerRunner[] {
  const inventory = services.inventory as InventoryServices | undefined;
  const processNextImportBatchJob = inventory?.importBatches?.processNextImportBatchJob;
  const processNextProductResolutionMaintenanceJob =
    inventory?.importBatches?.processNextImportProductResolutionMaintenanceJob;
  const processNextImportDraftListingDelivery = inventory?.importBatches?.processNextImportDraftListingDelivery;

  if (
    !processNextImportBatchJob &&
    !processNextProductResolutionMaintenanceJob &&
    !processNextImportDraftListingDelivery
  )
    return [];

  const runners: WorkerRunner[] = [];
  if (processNextImportBatchJob || processNextImportDraftListingDelivery) {
    runners.push(
      ...createDurableJobLaneRunners({
        workflowName: "inventory.import-batch-jobs",
        laneCount: input.inventoryImportBatchJobLaneCount,
        runLane: async (lane) => {
          const draftDeliveryResult = processNextImportDraftListingDelivery
            ? await processNextImportDraftListingDelivery()
            : { outcome: "idle" as const };
          if (draftDeliveryResult.outcome === "requeued") {
            logger.warn("Inventory draft listing delivery requeued.", {
              type: "inventory.import-draft-listing.delivery.requeued",
              messageId: draftDeliveryResult.messageId,
              attempts: draftDeliveryResult.attempts,
              code: draftDeliveryResult.code,
            });
          } else if (draftDeliveryResult.outcome === "failed") {
            logger.error("Inventory draft listing delivery failed permanently.", {
              type: "inventory.import-draft-listing.delivery.failed",
              messageId: draftDeliveryResult.messageId,
              attempts: draftDeliveryResult.attempts,
              code: draftDeliveryResult.code,
            });
          }
          return {
            processed:
              (processNextImportBatchJob
                ? await processNextImportBatchJob({
                    claimOwnerId: `${input.workerId}:${lane.laneName}`,
                    claimTtlMs: input.leaseTtlMs * 4,
                    workflowMaxActiveClaims: input.inventoryImportBatchJobWorkflowMaxActiveClaims,
                    jobMaxActiveClaims: input.inventoryImportBatchJobMaxActiveClaimsPerJob,
                    laneName: lane.laneName,
                    signal: lane.runnerContext?.signal,
                    throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
                  })
                : 0) + (draftDeliveryResult.outcome === "idle" ? 0 : 1),
            lastGlobalPosition: "0" as never,
          };
        },
      }),
    );
  }
  runners.push(...createInventoryProductResolutionMaintenanceRunners(services, input));
  return runners;
}

export function createInventoryImportProductResolutionMaintenanceEnqueueRunners({
  services,
  controlPlane,
}: Pick<WorkerJobInput<Readonly<Record<string, never>>>, "services" | "controlPlane">): readonly WorkerRunner[] {
  const inventory = services.inventory as InventoryServices | undefined;
  return inventory?.importBatches?.enqueueProductResolutionMaintenanceJob
    ? [
        createScheduledJobRunner(
          "inventory.import-product-resolution-maintenance.enqueue",
          24 * 60 * 60 * 1000,
          controlPlane,
          async () => {
            await inventory.importBatches.enqueueProductResolutionMaintenanceJob({ validatorVersion: 1 });
            return 1;
          },
        ),
      ]
    : [];
}
