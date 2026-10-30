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
    version bigint NOT NULL DEFAULT 0,
    next_reevaluation_at timestamptz NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_cohort_transitions (
    transition_id text PRIMARY KEY,
    seller_account_id text NOT NULL,
    transition_version bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN ('entered','exited','disclosure-band-changed')),
    effective_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    policy_version text NOT NULL,
    target_state text NOT NULL,
    target_band text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz NULL
  )`,
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_evaluation_failures (
    seller_account_id text NOT NULL,
    evaluation_at timestamptz NOT NULL,
    failure_kind text NOT NULL,
    detail text NOT NULL,
    policy_version text NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (seller_account_id, evaluation_at, failure_kind)
  )`,
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_sweep_checkpoints (
    trigger_name text PRIMARY KEY,
    snapshot_change_sequence bigint NOT NULL,
    after_seller_account_id text NULL,
    policy_version text NOT NULL,
    pass_started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_policy_evidence (
    policy_version text PRIMARY KEY,
    effective_from timestamptz NOT NULL,
    value jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_cohorts_due_idx ON platform_operations_seller_compliance_cohorts (next_reevaluation_at) WHERE next_reevaluation_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_transitions_unpublished_idx ON platform_operations_seller_compliance_cohort_transitions (recorded_at) WHERE published_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_transitions_seller_idx ON platform_operations_seller_compliance_cohort_transitions (seller_account_id, transition_version)`,
];

export const sellerComplianceCohortSchemaSql = `${sellerComplianceCohortSchemaStatements.join(";\n\n")};\n`;
export const sellerComplianceCohortSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261028_platform_operations_seller_compliance_cohorts",
    description: "Create seller compliance cohort state, transition ledger, and evaluation failures.",
    statements: sellerComplianceCohortSchemaStatements,
  },
];
