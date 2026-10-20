import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const accountAppealSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS platform_operations_account_appealable_actions (
    appealable_action_id text PRIMARY KEY, owner_account_id text NOT NULL, source text NOT NULL,
    source_stream_id text NOT NULL, source_stream_version integer NOT NULL, occurred_at timestamptz NOT NULL,
    source_event_type text NOT NULL, conflict_state text NOT NULL DEFAULT 'clear', conflict_reason text NULL,
    inserted_at timestamptz NOT NULL DEFAULT now(), UNIQUE (source_stream_id, source_stream_version)
  );`,
  `CREATE TABLE IF NOT EXISTS platform_operations_account_appeals (
    appeal_id text PRIMARY KEY, tenant_id text NOT NULL, account_id text NOT NULL, appealable_action_id text NOT NULL,
    statement text NOT NULL, status text NOT NULL, outcome text NULL, rationale text NULL, filed_by_user_id text NOT NULL,
    operator_user_id text NULL, note text NULL, stream_version integer NOT NULL, updated_at timestamptz NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS platform_operations_account_appeal_seller_history (
    appeal_id text PRIMARY KEY, account_id text NOT NULL, appealable_action_id text NOT NULL, statement text NOT NULL,
    status text NOT NULL, outcome text NULL, rationale text NULL, filed_by_user_id text NOT NULL, stream_version integer NOT NULL, updated_at timestamptz NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS platform_operations_account_appeal_operator_history (
    appeal_id text PRIMARY KEY, status text NOT NULL, outcome text NULL, rationale text NULL, operator_user_id text NULL,
    note text NULL, stream_version integer NOT NULL, updated_at timestamptz NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS platform_operations_account_appeals_account_idx ON platform_operations_account_appeals(account_id, updated_at DESC);`,
] as const;

export const accountAppealSchemaSql = accountAppealSchemaStatements.join("\n");
export const accountAppealSchemaMigrations: readonly BcSchemaMigration[] = [{ migrationId: "20261020_platform_operations_account_appeals", description: "Create account-appeal registry and projection tables.", statements: accountAppealSchemaStatements }];
