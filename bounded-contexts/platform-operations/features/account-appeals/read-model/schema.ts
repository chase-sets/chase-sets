import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const accountAppealSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_operations_account_appealable_actions (
  appealable_action_id text PRIMARY KEY,
  owner_account_id text NOT NULL,
  source text NOT NULL,
  source_stream_id text NOT NULL,
  source_stream_version integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_event_type text NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_stream_id, source_stream_version)
);
CREATE TABLE IF NOT EXISTS platform_operations_account_appeals (
  appeal_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  appealable_action_id text NOT NULL,
  statement text NOT NULL,
  status text NOT NULL,
  outcome text NULL,
  rationale text NULL,
  filed_by_user_id text NOT NULL,
  operator_user_id text NULL,
  note text NULL,
  stream_version integer NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_operations_account_appeals_account_idx ON platform_operations_account_appeals(account_id, updated_at DESC);
`;

export const accountAppealSchemaMigrations: readonly BcSchemaMigration[] = [{
  migrationId: "20261020_platform_operations_account_appeals",
  description: "Create account-appeal registry and projection tables.",
  statements: [accountAppealSchemaSql],
}];
