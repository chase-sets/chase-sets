import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const statements = [
  `CREATE TABLE IF NOT EXISTS auth_connector_clients (
    client_id text PRIMARY KEY,
    redirect_uri text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_connector_grants (
    grant_id text PRIMARY KEY,
    connection_id text NOT NULL,
    account_id text NOT NULL,
    pairing_id text NOT NULL UNIQUE,
    user_id text NOT NULL,
    client_id text NOT NULL REFERENCES auth_connector_clients(client_id),
    revision integer NOT NULL CHECK (revision > 0),
    revoked_at timestamptz,
    expires_at timestamptz NOT NULL,
    code_hash text UNIQUE,
    code_challenge text NOT NULL,
    code_expires_at timestamptz NOT NULL,
    access_hash text UNIQUE,
    access_expires_at timestamptz,
    refresh_hash text UNIQUE,
    created_at timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS auth_connector_grants_live_connection_idx
    ON auth_connector_grants (connection_id) WHERE revoked_at IS NULL`,
] as const;

export const connectorOAuthSchemaSql = statements.join(";\n") + ";";
export const connectorOAuthSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260914_auth_connector_oauth",
    description: "Separate public PKCE connector clients and connection-bound rotating grants.",
    statements,
  },
];
