import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { pricingRepricingPolicySchemaSql } from "./schema";

export const pricingRepricingPolicySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260914_pricing_repricing_halt",
    description: "Project the account Repricing Halt and exclude engaged accounts from assignments.",
    statements: [pricingRepricingPolicySchemaSql],
  },
];
