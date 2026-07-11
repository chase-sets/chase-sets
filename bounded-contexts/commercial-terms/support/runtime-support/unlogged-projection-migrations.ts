import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const commercialTermsUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_commercial_terms_unlogged_projections",
    description: "Store replayable Commercial Terms projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE commercial_terms_account_pages SET UNLOGGED;",
      // The agreement/schedule pages and history tables were retired by the
      // drop migration below once their reads and writes moved onto the
      // shared platform_policy_documents table. `IF EXISTS` keeps this
      // already-shipped migration entry replay-safe on a database that never
      // had these tables -- boot schema SQL no longer creates them, so a
      // fresh bootstrap must not fail here waiting for the drop migration
      // later in the same ledger. Any database that already ran this
      // migration against the original tables is unaffected: ALTER TABLE IF
      // EXISTS behaves identically to plain ALTER TABLE when the relation is
      // present.
      "ALTER TABLE IF EXISTS commercial_terms_agreement_history SET UNLOGGED;",
      "ALTER TABLE IF EXISTS commercial_terms_agreement_pages SET UNLOGGED;",
      "ALTER TABLE IF EXISTS commercial_terms_schedule_history SET UNLOGGED;",
      "ALTER TABLE IF EXISTS commercial_terms_schedule_pages SET UNLOGGED;",
    ],
  },
  {
    migrationId: "20260711_commercial_terms_retired_policy_tables_drop",
    description:
      "Drop the bespoke schedule/agreement pages and history tables retired by the platform-policy convergence; reads and writes moved to platform_policy_documents/history.",
    statements: [
      "SET lock_timeout = '5s';",
      "DROP TABLE IF EXISTS commercial_terms_agreement_history;",
      "DROP TABLE IF EXISTS commercial_terms_agreement_pages;",
      "DROP TABLE IF EXISTS commercial_terms_schedule_history;",
      "DROP TABLE IF EXISTS commercial_terms_schedule_pages;",
    ],
  },
];
