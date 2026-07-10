import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const commercialTermsUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_commercial_terms_unlogged_projections",
    description: "Store replayable Commercial Terms projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE commercial_terms_account_pages SET UNLOGGED;",
      "ALTER TABLE commercial_terms_agreement_history SET UNLOGGED;",
      "ALTER TABLE commercial_terms_agreement_pages SET UNLOGGED;",
      "ALTER TABLE commercial_terms_schedule_history SET UNLOGGED;",
      "ALTER TABLE commercial_terms_schedule_pages SET UNLOGGED;",
    ],
  },
];
