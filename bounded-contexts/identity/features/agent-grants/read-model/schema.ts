import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const identityAgentGrantRevocationSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261012_identity_agent_grant_revocation_support",
    description: "Index retained owner and attempt facts; installing support never activates revocation routes.",
    statements: [
      `CREATE TABLE IF NOT EXISTS identity_agent_grant_revocation_work (
        account_id text NOT NULL, grant_id text NOT NULL, position bigserial NOT NULL,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), completed boolean NOT NULL DEFAULT false,
        PRIMARY KEY (account_id, grant_id)
      )`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS identity_agent_grant_revocation_work_due_idx
        ON identity_agent_grant_revocation_work (next_attempt_at, position) WHERE completed = false`,
      `CREATE TABLE IF NOT EXISTS identity_agent_grant_dormant_requests (
        request_id uuid PRIMARY KEY, instance_id text NOT NULL
      )`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS identity_agent_grant_revocation_pending_idx ON event_store_events (global_position)
      WHERE event_type = 'identity.agent-grant-revocation.admitted'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS identity_agent_grant_revocation_attempt_owner_idx ON event_store_events ((payload->>'ownerStream'))
      WHERE event_type = 'identity.agent-grant-revocation-attempt.admitted'`,
    ],
  },
];
