import type { InventoryServices } from "@chase-sets/inventory/server";
import type { Logger } from "@chase-sets/observability";
import { createDurableJobLaneRunners, type WorkerRunner } from "@chase-sets/platform-runtime/worker";
import { createInventoryProductResolutionMaintenanceRunners } from "./scheduled-runners";
import type { PlatformWorkerConfig } from "./config";

export type InventoryJobRunnerConfig = Pick<
  PlatformWorkerConfig,
  | "workerId"
  | "leaseTtlMs"
  | "inventoryImportBatchJobLaneCount"
  | "inventoryImportBatchJobWorkflowMaxActiveClaims"
  | "inventoryImportBatchJobMaxActiveClaimsPerJob"
>;

export function createInventoryJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: InventoryJobRunnerConfig,
  logger: Pick<Logger, "warn" | "error">,
): readonly WorkerRunner[] {
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
