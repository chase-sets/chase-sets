import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const pricingAuthorityRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "pricing_evaluation_budget_admissions",
    owner: "pricing",
    reason:
      "Canonical evaluation admissions and released receipts retain the original evaluation binding. Age or replay cannot release a promise or admit a delayed retry again; closure precedes consumer abort and release. Never age-swept.",
  },
  {
    tableName: "pricing_repricing_round_admissions",
    owner: "pricing",
    reason:
      "Canonical Product round admissions retain original round identities and checkpoints, including completed receipts. R4 permits closure only through the owning terminal or recorded same-round recovery, never elapsed time. Never age-swept.",
  },
];
