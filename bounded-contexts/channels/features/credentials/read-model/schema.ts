import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const table = `CREATE TABLE IF NOT EXISTS channels_connection_credentials (
  row_id text PRIMARY KEY,
  version text NOT NULL CHECK (version = 'ChannelCredentialEnvelope/v1'),
  kind text NOT NULL CHECK (kind = 'oauth-token-set'),
  provider_key text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  account_id text NOT NULL,
  connection_id text NOT NULL,
  payload_format text NOT NULL CHECK (payload_format = 'ChannelOAuthTokenSet/v1'),
  token_generation bigint NOT NULL CHECK (token_generation BETWEEN 1 AND 9007199254740991),
  envelope_revision bigint NOT NULL CHECK (envelope_revision BETWEEN 1 AND 9007199254740991),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 32768),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  created_at text NOT NULL,
  updated_at text NOT NULL
)`;
const index =
  "CREATE INDEX IF NOT EXISTS channels_connection_credentials_key_page_idx ON channels_connection_credentials (key_id, row_id)";

export const channelCredentialSchemaSql = `${table};\n${index};`;
export const channelCredentialSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260923_channels_connection_credentials",
    description: "Persist non-replayable Channel credential custody with indexed named-key rotation.",
    statements: [
      table,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_connection_credentials_key_page_idx ON channels_connection_credentials (key_id, row_id)",
    ],
  },
];
