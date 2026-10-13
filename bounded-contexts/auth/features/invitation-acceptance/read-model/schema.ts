import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const invitationAttemptSchemaSql = `
CREATE TABLE IF NOT EXISTS auth_invitation_acceptance_attempts (
  attempt_id text PRIMARY KEY,
  terminal_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`;

export const invitationAttemptSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261012_invitation_acceptance_attempts",
    description: "Add non-authoritative terminal attempt retention markers.",
    statements: [
      invitationAttemptSchemaSql,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_invitation_acceptance_attempts_terminal_idx ON auth_invitation_acceptance_attempts (terminal_at) WHERE terminal_at IS NOT NULL",
    ],
  },
];
