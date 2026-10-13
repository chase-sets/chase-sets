import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const identityAgentGrantRevocationSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261012_identity_agent_grant_revocation_support",
    description: "Index retained owner and attempt facts; installing support never activates revocation routes.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS identity_agent_grant_revocation_pending_idx ON event_store_events (global_position)
      WHERE event_type = 'identity.agent-grant-revocation.admitted'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS identity_agent_grant_revocation_attempt_owner_idx ON event_store_events ((payload->>'ownerStream'))
      WHERE event_type = 'identity.agent-grant-revocation-attempt.admitted'`,
    ],
  },
];
