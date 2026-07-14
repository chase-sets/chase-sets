import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const customerFeedbackRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "customer_feedback_csat_invitations",
    owner: "customer-feedback",
    reason:
      "Invitation rows are replayable lifecycle projections used for single-use redemption, cooldown explanation, response-rate denominators, and suppression audit; they are not disposable request history.",
  },
];
