const tables = `
CREATE TABLE IF NOT EXISTS payments_card_decline_counters (
  fingerprint_digest text PRIMARY KEY,
  decline_count integer NOT NULL CHECK (decline_count > 0),
  reset_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS payments_card_decline_events (
  processor_name text NOT NULL,
  event_id text NOT NULL,
  facts_digest text NOT NULL,
  PRIMARY KEY (processor_name, event_id)
);
`;

export const paymentsCardDeclineSchemaSql = `${tables}
CREATE INDEX IF NOT EXISTS payments_card_decline_counters_expiry_idx
  ON payments_card_decline_counters (reset_at, fingerprint_digest);
`;

export const paymentsCardDeclineSchemaMigrations = [
  {
    migrationId: "20261004_payments_card_decline_velocity",
    description: "Share card decline windows and durable webhook receipts across Payments replicas.",
    statements: [
      tables,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_card_decline_counters_expiry_idx
    ON payments_card_decline_counters (reset_at, fingerprint_digest)`,
    ],
  },
] as const;
