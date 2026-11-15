import type { WorkerRunner } from "@chase-sets/bounded-context-module";

import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { PricingServices } from "@chase-sets/pricing/server";
import type { SettlementServices } from "@chase-sets/settlement/server";
import type { PlatformOperationsServices } from "./services";
import { SUPPORT_EVIDENCE_CLEANUP_RUNNER } from "../../features/support-requests/api/attachment-cleanup";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreatePlatformOperationsSellerComplianceCohortSweepRunnersConfig = Readonly<{}>;
export function createPlatformOperationsSellerComplianceCohortSweepRunners({
  services,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreatePlatformOperationsSellerComplianceCohortSweepRunnersConfig>,
  "services" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const platformOperations = services["platform-operations"] as PlatformOperationsServices | undefined;
  const runners: WorkerRunner[] = [];
  if (platformOperations?.sellerComplianceCohorts) {
    runners.push(
      createScheduledJobRunner("platform-operations.seller-compliance-cohort-sweep", 60_000, controlPlane, async () => {
        const result = await platformOperations.sellerComplianceCohorts.runTick({ limit: 100 });
        if (result.failed) logger.warn("Seller compliance cohort evaluations failed.", { result });
        return result.processed;
      }),
    );
  }
  return runners;
}

type CreatePlatformOperationsSupportRequestDeadlineSweepRunnersConfig = Readonly<{
  supportRequestDeadlineSweepIntervalMs: number | null;
}>;
export function createPlatformOperationsSupportRequestDeadlineSweepRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreatePlatformOperationsSupportRequestDeadlineSweepRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const platformOperations = services["platform-operations"] as PlatformOperationsServices | undefined;
  const sweepSupportRequestDeadlines = platformOperations?.supportRequests?.sweepSupportRequestDeadlines;
  const runners: WorkerRunner[] = [];
  if (sweepSupportRequestDeadlines && input.supportRequestDeadlineSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "platform-operations.support-request-deadline-sweep",
        input.supportRequestDeadlineSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepSupportRequestDeadlines({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Support request deadline sweep completed.", {
            type: "platform-operations.support-request-deadline-sweep",
            result,
          });
          return (
            result.autoResolved +
            result.fallbackEscalated +
            result.escalated +
            result.autoClosed +
            result.responseRemindersEmitted +
            result.reviewRemindersEmitted +
            result.returnRefundsReleased
          );
        },
      ),
    );
  }
  return runners;
}

type CreatePlatformOperationsSupportEvidenceCleanupRunnersConfig = Readonly<{
  supportEvidenceCleanupIntervalMs: number | null;
}>;
export function createPlatformOperationsSupportEvidenceCleanupRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreatePlatformOperationsSupportEvidenceCleanupRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const supportEvidenceCleanup = (services["platform-operations"] as PlatformOperationsServices | undefined)
    ?.supportRequests.attachmentCleanup;
  const runners: WorkerRunner[] = [];
  if (supportEvidenceCleanup?.kind === "available" && input.supportEvidenceCleanupIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        SUPPORT_EVIDENCE_CLEANUP_RUNNER,
        input.supportEvidenceCleanupIntervalMs,
        controlPlane,
        async () => {
          const result = await supportEvidenceCleanup.run();
          // Healthy polls and routine retention stay silent; only a refusal or a failure is signalled.
          if (result.denied || result.failed || result.auditUnavailable || result.invalid)
            logger.warn("Support evidence operation cleanup was refused or failed.", {
              type: SUPPORT_EVIDENCE_CLEANUP_RUNNER,
              result,
            });
          return result.abandoned + result.deleted + result.failed;
        },
      ),
    );
  }
  return runners;
}

type CreatePlatformOperationsGmvReconciliationRunnersConfig = Readonly<{ gmvReconciliationIntervalMs: number | null }>;
export function createPlatformOperationsGmvReconciliationRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreatePlatformOperationsGmvReconciliationRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const platformOperations = services["platform-operations"] as PlatformOperationsServices | undefined;
  const recordReconciliationRun = platformOperations?.opsDashboard?.recordReconciliationRun;
  const settlement = services.settlement as SettlementServices | undefined;
  const getLedgerSaleCreditTotalForMonth = settlement?.wallets?.getLedgerSaleCreditTotalForMonth;
  const pricing = isPricingServices(services.pricing) ? services.pricing : undefined;

  const getPlatformGmvForMonth = pricing?.marketRollups?.getPlatformGmvForMonth;
  const runners: WorkerRunner[] = [];
  if (
    getPlatformGmvForMonth &&
    getLedgerSaleCreditTotalForMonth &&
    recordReconciliationRun &&
    input.gmvReconciliationIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "platform-operations.gmv-reconciliation",
        input.gmvReconciliationIntervalMs,
        controlPlane,
        async () => {
          // Reconciles the most recently completed calendar month: on any
          // given day, the current month is still accumulating trades and
          // settlements, so comparing it would show expected, not
          // anomalous, "drift". A trailing re-check of the last completed
          // month (rather than a strict once-per-month run) mirrors the
          // rollup closer's own trailing-window re-derivation, catching a
          // late refund or settlement correction that lands after the
          // month first closes.
          const lastMonthDate = new Date();
          lastMonthDate.setUTCDate(0);
          const yearMonth = lastMonthDate.toISOString().slice(0, 7);
          const [tapeGmvAmount, ledgerSaleAmount] = await Promise.all([
            getPlatformGmvForMonth({ yearMonth }),
            getLedgerSaleCreditTotalForMonth({ yearMonth }),
          ]);
          const run = await recordReconciliationRun({ yearMonth, tapeGmvAmount, ledgerSaleAmount });
          const log = run.status === "drift-alarm" ? logger.warn : logger.info;
          log("Platform-operations GMV reconciliation completed.", {
            type: "platform-operations.gmv-reconciliation",
            yearMonth,
            tapeGmvAmount,
            ledgerSaleAmount,
            status: run.status,
          });
          return 1;
        },
      ),
    );
  }
  return runners;
}

function isPricingServices(value: unknown): value is PricingServices {
  return typeof value === "object" && value !== null && "priceSignals" in value && "marketRollups" in value;
}
