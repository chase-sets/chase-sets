import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import { createDurableJobLaneRunners } from "@chase-sets/platform-runtime/worker";
import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { SettlementServices } from "./services";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreateSettlementAccountLinkageCloserRunnersConfig = Readonly<{
  settlementAccountLinkageCloserIntervalMs: number | null;
}>;
export function createSettlementAccountLinkageCloserRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateSettlementAccountLinkageCloserRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const settlement = services.settlement as SettlementServices | undefined;
  const runAccountLinkageCloser = settlement?.accountLinkage?.runAccountLinkageCloser;
  const runners: WorkerRunner[] = [];
  if (runAccountLinkageCloser && input.settlementAccountLinkageCloserIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.account-linkage-closer",
        input.settlementAccountLinkageCloserIntervalMs,
        controlPlane,
        async () => {
          const result = await runAccountLinkageCloser({ limit: 500 });
          logger.info("Settlement account-linkage closer completed.", {
            type: "settlement.account-linkage-closer",
            result,
          });
          return result.flagsPublished;
        },
      ),
    );
  }
  return runners;
}

type CreateSettlementSellerFundsReleaseRunnersConfig = Readonly<{
  sellerFundsReleaseIntervalMs: number | null;
  workerId: string;
  leaseTtlMs: number;
}>;
export function createSettlementSellerFundsReleaseRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateSettlementSellerFundsReleaseRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const settlement = services.settlement as SettlementServices | undefined;
  const runners: WorkerRunner[] = [];
  if (settlement && input.sellerFundsReleaseIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.seller-funds-release",
        input.sellerFundsReleaseIntervalMs,
        controlPlane,
        async () => {
          const result = await settlement.wallets.releaseMaturePendingSaleCredits(
            {
              limit: 500,
              claimOwnerId: input.workerId,
              claimTtlMs: input.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Seller funds release completed.", {
            type: "settlement.funds-release",
            result,
          });
          return typeof result === "object" && result && "released" in result
            ? Number((result as { released: unknown }).released)
            : 0;
        },
      ),
    );
  }
  return runners;
}

type CreateSettlementSpendHoldSweepRunnersConfig = Readonly<{ spendHoldSweepIntervalMs: number | null }>;
export function createSettlementSpendHoldSweepRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateSettlementSpendHoldSweepRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const settlement = services.settlement as SettlementServices | undefined;

  const runners: WorkerRunner[] = [];
  if (settlement && input.spendHoldSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.spend-hold-sweep",
        input.spendHoldSweepIntervalMs,
        controlPlane,
        async () => {
          // Backstop against buyer-spend holds leaking on payments that never
          // conclude: release any hold whose expiry has elapsed, returning the
          // reserved credit to the buyer's spendable balance.
          const result = await settlement.wallets.sweepExpiredSpendHolds({ limit: 500 }, SYSTEM_CONTEXT);
          logger.info("Spend-hold sweep completed.", {
            type: "settlement.spend-hold-sweep",
            result,
          });
          return typeof result === "object" && result && "released" in result
            ? Number((result as { released: unknown }).released)
            : 0;
        },
      ),
    );
  }
  return runners;
}

type CreateSettlementPayoutReconciliationRunnersConfig = Readonly<{
  payoutReconciliationIntervalMs: number | null;
  workerId: string;
  leaseTtlMs: number;
}>;
export function createSettlementPayoutReconciliationRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateSettlementPayoutReconciliationRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const settlement = services.settlement as SettlementServices | undefined;
  const runners: WorkerRunner[] = [];
  if (settlement && input.payoutReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.payout-reconciliation",
        input.payoutReconciliationIntervalMs,
        controlPlane,
        async () => {
          const result = await settlement.payouts.reconcilePayoutsNeedingAttention(
            {
              limit: 100,
              claimOwnerId: input.workerId,
              claimTtlMs: input.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Payout reconciliation completed.", {
            type: "settlement.reconciliation",
            result,
          });
          return typeof result === "object" && result && "checked" in result
            ? Number((result as { checked: unknown }).checked)
            : 0;
        },
      ),
    );
  }
  return runners;
}

type CreateSettlementLiabilityReconciliationRunnersConfig = Readonly<{
  liabilityReconciliationIntervalMs: number | null;
}>;
export function createSettlementLiabilityReconciliationRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateSettlementLiabilityReconciliationRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const settlement = services.settlement as SettlementServices | undefined;
  const runners: WorkerRunner[] = [];
  if (settlement && input.liabilityReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.liability-reconciliation",
        input.liabilityReconciliationIntervalMs,
        controlPlane,
        async () => {
          // Solvency invariant: the provider platform balance must cover what the
          // platform owes sellers (Σ wallet liabilities + in-flight payout
          // demand). A shortfall beyond tolerance is a leak signal (double
          // transfer, missed reversal) that is otherwise invisible until
          // cash-out. Detective control only -- it never moves money.
          const result = await settlement.liabilityReconciliation.reconcileLedgerAgainstProvider({
            currencyCode: "usd",
          });
          const log = result.status === "shortfall-alarm" ? logger.warn : logger.info;
          log("Settlement liability reconciliation completed.", {
            type: "settlement.liability-reconciliation",
            status: result.status,
            currencyCode: result.currencyCode,
            expectedObligationAmount: result.expectedObligationAmount,
            providerAvailableAmount: result.providerAvailableAmount,
            driftAmount: result.driftAmount,
          });
          return result.status === "shortfall-alarm" ? 1 : 0;
        },
      ),
    );
  }
  return runners;
}

type CreateSettlementJobRunnersConfig = Readonly<{
  settlementPayoutReconciliationJobLaneCount: number;
  workerId: string;
  leaseTtlMs: number;
  settlementPayoutReconciliationJobWorkflowMaxActiveClaims: number;
  settlementPayoutReconciliationJobMaxActiveClaimsPerJob: number;
}>;
export function createSettlementJobRunners({
  services,
  config: input,
}: Pick<WorkerJobInput<CreateSettlementJobRunnersConfig>, "services" | "config">): readonly WorkerRunner[] {
  const settlement = services.settlement as SettlementServices | undefined;
  const processNextPayoutReconciliationJob = settlement?.payouts?.processNextPayoutReconciliationJob;

  if (!processNextPayoutReconciliationJob) {
    return [];
  }

  return createDurableJobLaneRunners({
    workflowName: "settlement.payout-reconciliation-jobs",
    laneCount: input.settlementPayoutReconciliationJobLaneCount,
    runLane: async (lane) => ({
      processed: await processNextPayoutReconciliationJob({
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
        claimTtlMs: input.leaseTtlMs * 4,
        workflowMaxActiveClaims: input.settlementPayoutReconciliationJobWorkflowMaxActiveClaims,
        jobMaxActiveClaims: input.settlementPayoutReconciliationJobMaxActiveClaimsPerJob,
        laneName: lane.laneName,
        signal: lane.runnerContext?.signal,
        throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
      }),
      lastGlobalPosition: "0" as never,
    }),
  });
}
