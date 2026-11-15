import type { WorkerRunner } from "@chase-sets/bounded-context-module";

import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { CustomerFeedbackServices } from "./services";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreateCustomerFeedbackAttentionDigestRunnersConfig = Readonly<{
  customerFeedbackAttentionDigestIntervalMs: number | null;
  customerFeedbackAttentionTeamRecipientUserIds: readonly string[];
}>;
export function createCustomerFeedbackAttentionDigestRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateCustomerFeedbackAttentionDigestRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const customerFeedback = services["customer-feedback"] as CustomerFeedbackServices | undefined;
  const runners: WorkerRunner[] = [];
  if (customerFeedback?.runAttentionDigest && input.customerFeedbackAttentionDigestIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "customer-feedback.attention-digest",
        input.customerFeedbackAttentionDigestIntervalMs,
        controlPlane,
        async () => {
          const result = await customerFeedback.runAttentionDigest!(
            {
              windowMinutes: Math.max(1, Math.floor(input.customerFeedbackAttentionDigestIntervalMs! / 60_000)),
              maxItemsPerGroup: 25,
              teamRecipientUserIds: input.customerFeedbackAttentionTeamRecipientUserIds,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Customer Feedback attention digest completed.", {
            type: "customer-feedback.attention-digest.completed",
            result,
          });
          return result.groupsRequested;
        },
      ),
    );
  }
  return runners;
}
