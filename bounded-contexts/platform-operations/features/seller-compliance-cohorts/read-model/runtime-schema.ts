import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const sellerComplianceRuntimeSchemaStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_sweep_checkpoints (
    trigger text PRIMARY KEY CHECK (trigger = 'cohort'),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    last_completed_snapshot bigint NOT NULL DEFAULT 0,
    current_snapshot bigint NULL,
    raw_page_cursor text NULL,
    seller_cursor text NULL,
    policy_horizon bigint NOT NULL DEFAULT 0,
    current_policy_horizon bigint NULL,
    evaluation_at timestamptz NULL,
    last_evaluation_at timestamptz NULL,
    CHECK ((current_snapshot IS NULL) = (evaluation_at IS NULL)),
    CHECK ((current_snapshot IS NULL) = (current_policy_horizon IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_evaluation_failures (
    seller_account_id text NOT NULL,
    evaluation_at timestamptz NOT NULL,
    failure_kind text NOT NULL,
    policy_version text NULL,
    detail text NOT NULL,
    PRIMARY KEY (seller_account_id, evaluation_at, failure_kind)
  )`,
];

export const sellerComplianceRuntimeSchemaSql = `${sellerComplianceRuntimeSchemaStatements.join(";\n\n")};\n`;
export const sellerComplianceRuntimeSchemaMigrations: readonly BcSchemaMigration[] = [{
  migrationId: "20261107_platform_operations_seller_compliance_runtime",
  description: "Create durable seller compliance replay checkpoint and deduplicated evaluation failures.",
  statements: sellerComplianceRuntimeSchemaStatements,
}];
