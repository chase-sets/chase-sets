import type { WorkerRunner } from "@chase-sets/bounded-context-module";

import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { OrderingServices } from "./services";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreateOrderingPaymentDeadlineSweepRunnersConfig = Readonly<{ paymentDeadlineSweepIntervalMs: number | null }>;
export function createOrderingPaymentDeadlineSweepRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateOrderingPaymentDeadlineSweepRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const ordering = services.ordering as OrderingServices | undefined;
  const sweepBreachedPaymentDeadlines = ordering?.orders?.sweepBreachedPaymentDeadlines;
  const runners: WorkerRunner[] = [];
  if (sweepBreachedPaymentDeadlines && input.paymentDeadlineSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "ordering.payment-deadline-sweep",
        input.paymentDeadlineSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepBreachedPaymentDeadlines({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Ordering payment deadline sweep completed.", {
            type: "ordering.payment-deadline-sweep",
            result,
          });
          if (result.failed > 0) {
            throw new Error(`Payment deadline sweep failed for ${result.failed} candidate(s).`);
          }
          return result.cancelled + result.progressed;
        },
      ),
    );
  }
  return runners;
}
