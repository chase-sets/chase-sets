import type { PaymentsServices } from "./services";
import type { WorkerRunner } from "@chase-sets/bounded-context-module";

import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreatePaymentsWalletFundingReconciliationRunnersConfig = Readonly<{
  paymentReconciliationIntervalMs: number | null;
  workerId: string;
  leaseTtlMs: number;
}>;
export function createPaymentsWalletFundingReconciliationRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreatePaymentsWalletFundingReconciliationRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const payments = services.payments as PaymentsServices | undefined;
  const runners: WorkerRunner[] = [];
  if (payments && input.paymentReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "payments.wallet-funding-reconciliation",
        input.paymentReconciliationIntervalMs,
        controlPlane,
        async () => {
          const result = await payments.walletFunding.reconcile(SYSTEM_CONTEXT);
          logger.info("Wallet funding reconciliation completed.", {
            type: "payments.wallet-funding-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
    runners.push(
      createScheduledJobRunner(
        "payments.reconciliation",
        input.paymentReconciliationIntervalMs,
        controlPlane,
        async () => {
          const result = await payments.payments.scanPaymentsNeedingReconciliation(
            {
              limit: 100,
              claimOwnerId: input.workerId,
              claimTtlMs: input.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Payment reconciliation scan completed.", {
            type: "payments.reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }
  return runners;
}
