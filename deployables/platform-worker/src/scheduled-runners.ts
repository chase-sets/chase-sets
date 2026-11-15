import type { PlatformWorkerConfig } from "./config";
import { createScheduledJobRunner, type WorkerJobLogger } from "@chase-sets/platform-runtime/worker-jobs";
export { createScheduledJobRunner } from "@chase-sets/platform-runtime/worker-jobs";
import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import { createWorkSignalCleanupRunner } from "@chase-sets/platform-runtime/projection-wake-scheduler";
import { createRetentionSweepRunner } from "@chase-sets/platform-runtime/retention-sweep";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import type { DiscoveryServices } from "@chase-sets/discovery/server";
import type { CatalogServices } from "@chase-sets/catalog/server";
import type { InventoryServices } from "@chase-sets/inventory/server";
import type { PricingServices } from "@chase-sets/pricing/server";
import type { SettlementServices } from "@chase-sets/settlement/server";
import type { PlatformOperationsHostPorts } from "@chase-sets/platform-operations/server";
import {
  createFilesystemPrivateObjectStore,
  createS3PrivateObjectStoreFromOptions,
  type PrivateObjectStore,
} from "@chase-sets/object-storage";
export type ScheduledRunnerLogger = Pick<WorkerJobLogger, "info" | "warn">;
export type RegisteredScheduledRunnerConfig = Pick<
  PlatformWorkerConfig,
  | "workerId"
  | "leaseTtlMs"
  | "paymentReconciliationIntervalMs"
  | "paymentDeadlineSweepIntervalMs"
  | "channelsConnectorLivenessSweepIntervalMs"
  | "supportRequestDeadlineSweepIntervalMs"
  | "supportEvidenceCleanupIntervalMs"
  | "customerFeedbackAttentionDigestIntervalMs"
  | "customerFeedbackAttentionTeamRecipientUserIds"
  | "reviewWindowSweepIntervalMs"
  | "reviewOpportunityReminderSweepIntervalMs"
  | "sellerAvailabilityRestoreSweepIntervalMs"
  | "sellerAwayWindowStartSweepIntervalMs"
  | "sellerFundsReleaseIntervalMs"
  | "spendHoldSweepIntervalMs"
  | "payoutReconciliationIntervalMs"
  | "liabilityReconciliationIntervalMs"
  | "marketRollupsCloserIntervalMs"
  | "settlementAccountLinkageCloserIntervalMs"
  | "gmvReconciliationIntervalMs"
  | "catalogProviderScopeRefreshIntervalMs"
  | "googleMerchant"
  | "googleShoppingMaintenanceIntervalMs"
  | "googleShoppingMaintenanceBatchSize"
  | "googleShoppingRefreshWindowDays"
  | "googleShoppingDiagnosticsIntervalMs"
  | "googleShoppingDiagnosticsBatchSize"
  | "discoverySearchEmbeddings"
>;
export function createDeferredScheduledRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: {
  services: Readonly<Record<string, unknown>>;
  config: RegisteredScheduledRunnerConfig;
  controlPlane: PlatformControlPlane;
  logger: ScheduledRunnerLogger;
}): readonly WorkerRunner[] {
  const runners: WorkerRunner[] = [];
  const discovery = services.discovery as DiscoveryServices | undefined;
  if (
    discovery?.googleShoppingSync?.processScheduledMaintenanceSync &&
    input.googleMerchant.syncEnabled &&
    input.googleShoppingMaintenanceIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "discovery.google-shopping-maintenance",
        input.googleShoppingMaintenanceIntervalMs,
        controlPlane,
        async () => {
          const processed = await discovery.googleShoppingSync!.processScheduledMaintenanceSync!({
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
            limit: input.googleShoppingMaintenanceBatchSize,
            refreshWindowDays: input.googleShoppingRefreshWindowDays,
          });
          logger.info("Google Shopping maintenance scan completed.", {
            type: "google-shopping.maintenance",
            processed,
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
          });
          return processed;
        },
      ),
    );
  }

  if (
    discovery?.googleShoppingSync?.processScheduledDiagnosticsRefresh &&
    input.googleMerchant.syncEnabled &&
    input.googleShoppingDiagnosticsIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "discovery.google-shopping-diagnostics",
        input.googleShoppingDiagnosticsIntervalMs,
        controlPlane,
        async () => {
          const processed = await discovery.googleShoppingSync!.processScheduledDiagnosticsRefresh!({
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
            batchSize: input.googleShoppingDiagnosticsBatchSize,
          });
          logger.info("Google Shopping diagnostics refresh scan completed.", {
            type: "google-shopping.diagnostics",
            processed,
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
          });
          return processed;
        },
      ),
    );
  }
  return runners;
}
export function createInfrastructureScheduledRunners({
  services,
  controlPlane,
  logger,
  workSignalCleanup,
  retentionSweep,
}: {
  services: Readonly<Record<string, unknown>>;
  controlPlane: PlatformControlPlane;
  logger: ScheduledRunnerLogger;
  workSignalCleanup: () => Omit<Parameters<typeof createWorkSignalCleanupRunner>[0], "controlPlane">;
  retentionSweep: () => Omit<Parameters<typeof createRetentionSweepRunner>[0], "controlPlane">;
}): readonly WorkerRunner[] {
  const durableJobRetention = createDurableJobRetentionTask(services, logger);
  const runners: WorkerRunner[] = [];
  if (durableJobRetention) {
    runners.push(createScheduledJobRunner("durable-jobs.retention", 60 * 60 * 1000, controlPlane, durableJobRetention));
  }
  return [
    ...runners,
    createWorkSignalCleanupRunner({ controlPlane, ...workSignalCleanup() }),
    createRetentionSweepRunner({ controlPlane, ...retentionSweep() }),
  ];
}
function createDurableJobRetentionTask(
  services: Readonly<Record<string, unknown>>,
  logger: ScheduledRunnerLogger,
): (() => Promise<number>) | null {
  const tasks: Array<() => Promise<number>> = [];
  const discovery = services.discovery as DiscoveryServices | undefined;
  const catalog = services.catalog as CatalogServices | undefined;
  const inventory = services.inventory as InventoryServices | undefined;
  const pricing = services.pricing as PricingServices | undefined;
  const settlement = services.settlement as SettlementServices | undefined;

  const completedBefore = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stagedInputCreatedBefore = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (catalog?.authoringBulkJobs?.pruneRetention) {
    tasks.push(() => catalog.authoringBulkJobs!.pruneRetention!({ completedBefore: completedBefore(), limit: 500 }));
  }
  if (catalog?.sourceObservations?.pruneSourceObservationJobRetention) {
    tasks.push(async () => {
      const result = await catalog.sourceObservations!.pruneSourceObservationJobRetention!({
        completedBefore: completedBefore(),
        limit: 500,
      });
      return result.bulkReviewJobs + result.integrationJobs;
    });
  }
  if (inventory?.importBatches?.pruneImportBatchJobRetention) {
    tasks.push(async () => {
      const result = await inventory.importBatches!.pruneImportBatchJobRetention!({
        completedBefore: completedBefore(),
        stagedInputCreatedBefore: stagedInputCreatedBefore(),
        limit: 500,
      });
      if (result.commitJobsHeld || !result.handoffs.complete) {
        logger.warn("Inventory import draft handoff scan held commit-job retention or did not finish its window.", {
          commitJobsHeld: result.commitJobsHeld,
          complete: result.handoffs.complete,
          pages: result.handoffs.pages,
          counts: result.handoffs.counts,
          findings: result.handoffs.findings.slice(0, 10),
        });
      }
      return result.jobs + result.stagedInputs;
    });
  }
  if (pricing?.recommendations?.pruneRecommendationJobRetention) {
    tasks.push(() =>
      pricing.recommendations!.pruneRecommendationJobRetention!({ completedBefore: completedBefore(), limit: 500 }),
    );
  }
  if (settlement?.payouts?.prunePayoutReconciliationJobRetention) {
    tasks.push(() =>
      settlement.payouts!.prunePayoutReconciliationJobRetention!({
        completedBefore: completedBefore(),
        limit: 500,
      }),
    );
  }
  if (discovery?.googleShoppingSync?.pruneFullSyncJobRetention) {
    tasks.push(() =>
      discovery.googleShoppingSync!.pruneFullSyncJobRetention!({ completedBefore: completedBefore(), limit: 500 }),
    );
  }

  if (tasks.length === 0) {
    return null;
  }

  return async () => {
    const counts = await Promise.all(tasks.map((task) => task()));
    const deleted = counts.reduce((sum, count) => sum + count, 0);
    logger.info("Durable job retention completed.", {
      type: "durable-jobs.retention",
      deleted,
    });
    return deleted;
  };
}
export function createSupportEvidenceCleanupHostPort(
  config: Pick<
    PlatformWorkerConfig,
    "deploymentEnvironment" | "supportEvidenceCleanupBinding" | "supportEvidenceStorage"
  >,
  logger: Pick<ScheduledRunnerLogger, "info">,
  createStore: (storage: PlatformWorkerConfig["supportEvidenceStorage"]) => PrivateObjectStore = (storage) =>
    storage.kind === "s3"
      ? createS3PrivateObjectStoreFromOptions(storage)
      : createFilesystemPrivateObjectStore({ rootDir: `${storage.rootDir}-private-support-evidence` }),
): Required<Pick<PlatformOperationsHostPorts, "supportEvidenceCleanup">> {
  const binding = config.supportEvidenceCleanupBinding;
  const denial =
    binding.kind === "denied"
      ? binding.diagnostic
      : config.supportEvidenceStorage.kind === "filesystem" &&
          !["local", "dev", "test"].includes(config.deploymentEnvironment)
        ? "binding_storage_unshared"
        : null;
  if (denial || binding.kind !== "configured") {
    logger.info("Support evidence operation cleanup is not mounted.", {
      type: "platform-operations.support-evidence-cleanup-binding",
      reason: denial,
    });
    return { supportEvidenceCleanup: { kind: "not-mounted" } };
  }
  const store = createStore(config.supportEvidenceStorage);
  return {
    supportEvidenceCleanup: {
      kind: "available",
      binding,
      storage: {
        deleteKeys: (keys) => store.deleteKeys(keys),
        verifyPrivate: (key, expected) => store.verifyPrivate(key, expected),
      },
    },
  };
}
