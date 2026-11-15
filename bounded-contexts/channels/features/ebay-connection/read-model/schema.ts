import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const statements = [
  `CREATE TABLE IF NOT EXISTS channels_ebay_oauth_attempts (
    state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
    account_id text NOT NULL, candidate_connection_id text NOT NULL,
    expected_connection_id text NULL, expected_generation bigint NULL,
    environment text NOT NULL CHECK (environment IN ('sandbox','production')),
    ru_name text NOT NULL, capabilities jsonb NOT NULL, scopes jsonb NOT NULL,
    created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels_ebay_seller_bindings (
    binding_id text PRIMARY KEY, account_id text NOT NULL,
    environment text NOT NULL CHECK (environment IN ('sandbox','production')),
    subject_fingerprint text NOT NULL CHECK (subject_fingerprint ~ '^v1:ebay-subject-root-v1:[a-f0-9]{64}$'),
    subject_key_id text NOT NULL, iv bytea NOT NULL CHECK (octet_length(iv)=12),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 1024),
    tag bytea NOT NULL CHECK (octet_length(tag)=16),
    current_connection_id text NULL UNIQUE, credential_reference text NULL,
    capabilities jsonb NOT NULL,
    UNIQUE (environment, subject_fingerprint),
    CHECK ((current_connection_id IS NULL) = (credential_reference IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS channels_ebay_disconnect_records (
    connection_id text PRIMARY KEY, binding_id text NOT NULL REFERENCES channels_ebay_seller_bindings(binding_id),
    account_id text NOT NULL, remote_revocation text NOT NULL CHECK (remote_revocation IN ('confirmed','already-revoked','unconfirmed')),
    seller_instruction text NOT NULL CHECK (seller_instruction = 'remove-chase-sets-access'),
    disconnected_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS channels_ebay_oauth_attempts_expiry_idx
    ON channels_ebay_oauth_attempts (expires_at, state_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channels_ebay_single_credential_idx
    ON channels_connection_credentials (connection_id) WHERE provider_key = 'ebay'`,
];
export const ebayConnectionSchemaSql = statements.join(";\n") + ";";
export const ebayConnectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261115_channels_ebay_connection",
    description: "Bind single-lineage Sandbox seller OAuth custody and terminal disconnect records.",
    statements: statements.map((statement) =>
      statement
        .replace("CREATE UNIQUE INDEX IF NOT EXISTS", "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS")
        .replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS"),
    ),
  },
];
