import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const identityAccountSchemaSql = `CREATE TABLE IF NOT EXISTS identity_accounts (
  account_id text PRIMARY KEY,
  name text NOT NULL,
  display_name text NOT NULL,
  account_type text NOT NULL,
  status text NOT NULL,
  badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  founder_number integer NULL CHECK (founder_number BETWEEN 1 AND 500),
  founders_window_started_at timestamptz NULL,
  founders_window_ends_at timestamptz NULL,
  last_enforcement_action_id text NULL,
  last_enforcement_reason text NULL,
  last_enforcement_reference jsonb NULL,
  last_enforcement_at timestamptz NULL,
  last_global_position bigint NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_accounts
  ADD COLUMN IF NOT EXISTS badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS founder_number integer NULL,
  ADD COLUMN IF NOT EXISTS founders_window_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS founders_window_ends_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_enforcement_action_id text NULL,
  ADD COLUMN IF NOT EXISTS last_enforcement_reason text NULL,
  ADD COLUMN IF NOT EXISTS last_enforcement_reference jsonb NULL,
  ADD COLUMN IF NOT EXISTS last_enforcement_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_global_position bigint NULL;

CREATE TABLE IF NOT EXISTS identity_account_display_name_reservations (
  display_name_key text PRIMARY KEY,
  account_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  operation_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`;

export const identityAccountSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260712_identity_account_founder_number_unique",
    description: "Keep every claimed founder number unique across Identity accounts.",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS identity_accounts_founder_number_uk
         ON identity_accounts (founder_number)
         WHERE founder_number IS NOT NULL;`,
    ],
  },
  {
    migrationId: "20260728_identity_display_name_reservation_operation_key",
    description:
      "Bind each display-name reservation to the Registration Operation that wrote it, so a retry of that operation reclaims its own row and no other operation can.",
    statements: [
      "SET lock_timeout = '5s';",
      `ALTER TABLE identity_account_display_name_reservations
         ADD COLUMN IF NOT EXISTS operation_key text NULL;`,
    ],
  },
  {
    migrationId: "20260819_identity_account_enforcement_fact",
    description:
      "Persist the latest Account Enforcement Action and its global ordering position without backfilling legacy account history.",
    statements: [
      `ALTER TABLE identity_accounts
         ADD COLUMN IF NOT EXISTS last_enforcement_action_id text NULL,
         ADD COLUMN IF NOT EXISTS last_enforcement_reason text NULL,
         ADD COLUMN IF NOT EXISTS last_enforcement_reference jsonb NULL,
         ADD COLUMN IF NOT EXISTS last_enforcement_at timestamptz NULL,
         ADD COLUMN IF NOT EXISTS last_global_position bigint NULL;`,
    ],
  },
];
