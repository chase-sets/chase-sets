import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const customerFeedbackRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "customer_feedback_csat_invitations",
    owner: "customer-feedback",
    reason:
      "Invitation rows are replayable lifecycle projections used for single-use redemption, cooldown explanation, response-rate denominators, and suppression audit; they are not disposable request history.",
  },
  {
    tableName: "customer_feedback_csat_analytics_facts",
    owner: "customer-feedback",
    reason:
      "One replayable row per invitation supplies unique lifecycle denominators, rating distributions, bounded trends, and projection-health diagnostics without retaining client-side counters.",
  },
  {
    tableName: "customer_feedback_feedback_cases",
    owner: "customer-feedback",
    reason: "Feedback case state is an operational projection rebuilt from the retained case event stream.",
  },
  {
    tableName: "customer_feedback_feedback_case_timeline",
    owner: "customer-feedback",
    reason: "Case timeline rows preserve attributed lifecycle history and rebuild from the retained case event stream.",
  },
  {
    tableName: "customer_feedback_case_attention",
    owner: "customer-feedback",
    reason:
      "Attention rows are replayable SLA and operator-queue projections rebuilt from the retained case event stream.",
  },
];
