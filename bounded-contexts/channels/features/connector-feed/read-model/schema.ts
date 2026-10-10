import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { connectorAuditReasons, connectorAuditRoutes } from "../domain/contracts";

const statements = [
  `CREATE TABLE IF NOT EXISTS channel_connector_pairings (
    pairing_id text PRIMARY KEY,
    created_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    connection_id text NOT NULL,
    account_id text NOT NULL,
    user_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('code', 'paired', 'closed')),
    revision integer NOT NULL CHECK (revision > 0),
    code_hash text UNIQUE,
    code_expires_at timestamptz NOT NULL,
    grant_id text UNIQUE,
    created_at timestamptz NOT NULL,
    closed_at timestamptz,
    last_seen_at timestamptz,
    CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
    CHECK (state <> 'paired' OR grant_id IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_connector_pairings_live_connection_idx
    ON channel_connector_pairings (connection_id) WHERE state <> 'closed'`,
  `CREATE INDEX IF NOT EXISTS channel_connector_pairings_connection_idx
    ON channel_connector_pairings (connection_id, created_sequence DESC)`,
  `CREATE TABLE IF NOT EXISTS channel_connector_audit (
    request_id text PRIMARY KEY,
    connection_id text,
    pairing_id text,
    route text NOT NULL CHECK (route IN (${connectorAuditRoutes.map((route) => `'${route}'`).join(",")})),
    outcome text NOT NULL CHECK (outcome IN ('accepted','refused')),
    reason text NOT NULL CHECK (reason IN (${connectorAuditReasons.map((reason) => `'${reason}'`).join(",")})),
    occurred_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS channel_connector_audit_connection_time_idx
    ON channel_connector_audit (connection_id, occurred_at DESC)`,
] as const;
const actorCodeIndex = `CREATE INDEX IF NOT EXISTS channel_connector_pairings_actor_code_idx
  ON channel_connector_pairings (account_id, user_id, created_sequence DESC) WHERE state = 'code'`;
export const connectorFeedSchemaSql = [...statements, actorCodeIndex].join(";\n") + ";";
export const connectorFeedSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260914_channels_connector_pairing",
    description: "Connection-scoped one-use pairing lifecycle and credential-safe request audit.",
    statements,
  },
  {
    migrationId: "20261007_channels_connector_actor_code_index",
    description: "Bound live pairing selection to the authorizing account and user.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_connector_pairings_actor_code_idx
        ON channel_connector_pairings (account_id, user_id, created_sequence DESC) WHERE state = 'code'`,
    ],
  },
  {
    migrationId: "20261010_channels_staged_import_policy_audit_route",
    description: "Admit the staged-import policy read in the existing credential-safe audit.",
    statements: [
      "SET LOCAL lock_timeout = '5s'",
      "ALTER TABLE channel_connector_audit DROP CONSTRAINT IF EXISTS channel_connector_audit_route_check",
      `ALTER TABLE channel_connector_audit ADD CONSTRAINT channel_connector_audit_route_check
       CHECK (route IN (${connectorAuditRoutes.map((route) => `'${route}'`).join(",")}))`,
    ],
  },
];
