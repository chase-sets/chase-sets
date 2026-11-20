import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const sellerComplianceCohortSchemaStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_cohorts (
    seller_account_id text PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('outside','member')),
    disclosure_band text NOT NULL CHECK (disclosure_band IN ('none','disclosure')),
    entry_effective_at timestamptz NULL,
    exit_effective_at timestamptz NULL,
    window_start timestamptz NULL,
    window_end timestamptz NULL,
    qualifying_count integer NOT NULL DEFAULT 0,
    qualifying_gross_cents bigint NOT NULL DEFAULT 0,
    unclassifiable_count integer NOT NULL DEFAULT 0,
    policy_version text NOT NULL,
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    next_reevaluation_at timestamptz NULL,
    updated_at timestamptz NOT NULL,
    CHECK (state = 'member' OR disclosure_band = 'none')
  )`,
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_cohort_transitions (
    transition_id text PRIMARY KEY,
    seller_account_id text NOT NULL,
    transition_version bigint NOT NULL CHECK (transition_version > 0),
    kind text NOT NULL CHECK (kind IN ('entered','exited','disclosure-band-changed')),
    effective_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    policy_version text NOT NULL,
    target_state text NOT NULL CHECK (target_state IN ('outside','member')),
    target_band text NOT NULL CHECK (target_band IN ('none','disclosure')),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz NULL,
    UNIQUE (seller_account_id, transition_version),
    CHECK (effective_at <= observed_at),
    CHECK ((kind = 'entered' AND target_state = 'member' AND target_band = 'none')
      OR (kind = 'exited' AND target_state = 'outside' AND target_band = 'none')
      OR (kind = 'disclosure-band-changed' AND target_state = 'member'))
  )`,
  `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_cohorts_due_idx ON platform_operations_seller_compliance_cohorts (next_reevaluation_at) WHERE next_reevaluation_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS platform_operations_cohort_transitions_unpublished_idx ON platform_operations_seller_compliance_cohort_transitions (recorded_at) WHERE published_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_transitions_seller_idx ON platform_operations_seller_compliance_cohort_transitions (seller_account_id, transition_version)`,
];

export const sellerComplianceCohortSchemaSql = `${sellerComplianceCohortSchemaStatements.join(";\n\n")};\n`;
export const sellerComplianceCohortSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261105_platform_operations_seller_compliance_cohorts",
    description: "Create seller compliance cohort state and immutable transition ledger.",
    statements: sellerComplianceCohortSchemaStatements,
  },
];
