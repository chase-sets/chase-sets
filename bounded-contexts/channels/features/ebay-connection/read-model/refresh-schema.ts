import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const statements = [
  `CREATE TABLE IF NOT EXISTS channels_ebay_credential_refresh (
    connection_id text NOT NULL UNIQUE, token_generation bigint NOT NULL CHECK (token_generation BETWEEN 1 AND 9007199254740991),
    account_id text NOT NULL, context jsonb NOT NULL,
    schedule_generation bigint NOT NULL CHECK (schedule_generation BETWEEN 1 AND 9007199254740991),
    attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 6),
    due_at timestamptz NULL, lease_id text NULL, lease_until timestamptz NULL,
    last_outcome text NOT NULL CHECK (last_outcome IN ('never','succeeded','retryable','exhausted','terminal')),
    PRIMARY KEY (connection_id, token_generation),
    CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
    CHECK (lease_id IS NULL OR (attempt > 0 AND due_at IS NOT NULL)),
    CHECK (last_outcome NOT IN ('exhausted','terminal') OR due_at IS NULL)
  )`,
  `CREATE INDEX IF NOT EXISTS channels_ebay_credential_refresh_due_idx
    ON channels_ebay_credential_refresh ((COALESCE(lease_until,due_at)),connection_id) WHERE due_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS channels_ebay_credential_refresh_outcomes (
    connection_id text NOT NULL, token_generation bigint NOT NULL, schedule_generation bigint NOT NULL,
    attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 6), observation jsonb NOT NULL,
    PRIMARY KEY (connection_id,token_generation,schedule_generation,attempt)
  )`,
];
export const ebayCredentialRefreshSchemaSql = statements.join(";\n") + ";";
export const ebayCredentialRefreshSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261116_channels_ebay_credential_refresh",
    description: "Persist generation-fenced eBay refresh cycles, leases and immutable health observations.",
    statements,
  },
];
