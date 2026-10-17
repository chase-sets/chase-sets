import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const catalogOperatorSessionSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_tcgplayer_operator_sessions (
  provider_key text PRIMARY KEY CHECK (provider_key = 'tcgplayer'),
  version text NOT NULL CHECK (version = 'CatalogOperatorSession/v1'),
  state text NOT NULL CHECK (state IN ('stored', 'cleared')),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  ciphertext bytea NULL,
  iv bytea NULL,
  tag bytea NULL,
  stored_at timestamptz NULL,
  observed_at timestamptz NULL,
  browser_expires_at timestamptz NULL,
  CONSTRAINT catalog_operator_session_custody_shape CHECK (
    (state = 'stored' AND ciphertext IS NOT NULL AND octet_length(ciphertext) BETWEEN 1 AND 4096
      AND iv IS NOT NULL AND octet_length(iv) = 12 AND tag IS NOT NULL AND octet_length(tag) = 16
      AND stored_at IS NOT NULL AND isfinite(stored_at) AND observed_at IS NOT NULL AND isfinite(observed_at)
      AND (browser_expires_at IS NULL OR isfinite(browser_expires_at)))
    OR (state = 'cleared' AND ciphertext IS NULL AND iv IS NULL AND tag IS NULL
      AND stored_at IS NULL AND observed_at IS NULL AND browser_expires_at IS NULL)
  )
);`;

export const catalogOperatorSessionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261001_catalog_operator_session_v1",
    description: "Retain encrypted operator custody and a monotonic credential-free Disconnect fence.",
    statements: [catalogOperatorSessionSchemaSql],
  },
];
