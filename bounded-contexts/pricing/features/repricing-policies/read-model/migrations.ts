import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { pricingRepricingPolicySchemaSql, pricingRepricingPolicyAuthoringIntentSchemaSql } from "./schema";

export const pricingRepricingPolicySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260914_pricing_repricing_halt",
    description: "Project the account Repricing Halt and exclude engaged accounts from assignments.",
    statements: [pricingRepricingPolicySchemaSql],
  },
  {
    migrationId: "20261028_pricing_policy_authoring_intent",
    description: "Retain semantic-bound, versioned authoring intent; historical policies remain custom.",
    statements: [pricingRepricingPolicyAuthoringIntentSchemaSql],
  },
];
