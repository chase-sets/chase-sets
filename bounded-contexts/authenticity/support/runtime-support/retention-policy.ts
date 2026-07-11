import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const authenticityRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "authenticity_cases",
    owner: "authenticity",
    reason:
      "Case rows are mutable event projections that continue to receive tracking, inspection, verdict, and forward/return updates through their lifecycle; they are not disposable request history.",
  },
];
