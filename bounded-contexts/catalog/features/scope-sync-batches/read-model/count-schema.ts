const eventKindCheck =
  "CONSTRAINT catalog_scope_sync_count_history_event_kind_check CHECK (event_kind IN ('usage', 'quoted', 'approved', 'debit', 'result', 'allocated', 'allocation-ended'))";

export const catalogCountHistoryTableSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_scope_sync_count_history (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  account_slot text NOT NULL,
  event_kind text NOT NULL,
  quote_id text NULL,
  query_key text NULL,
  debit_id text NULL,
  scope_record_id text NULL,
  count_kind text NULL CHECK (count_kind IN ('cards', 'sealed')),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  ${eventKindCheck}
);`;

// The new table's indexes are installed by boot before any count writes; no populated-table index migration is needed.
export const catalogCountHistorySchemaSql = `${catalogCountHistoryTableSchemaSql}
CREATE INDEX IF NOT EXISTS catalog_count_history_slot_kind_idx
  ON catalog_scope_sync_count_history (account_slot, event_kind, position DESC);
CREATE INDEX IF NOT EXISTS catalog_count_history_query_idx
  ON catalog_scope_sync_count_history (account_slot, query_key, position DESC) WHERE query_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_count_history_quote_idx
  ON catalog_scope_sync_count_history (quote_id, position DESC) WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_count_history_debit_idx
  ON catalog_scope_sync_count_history (debit_id) WHERE debit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_count_history_quote_claim_idx
  ON catalog_scope_sync_count_history (quote_id, scope_record_id, count_kind) WHERE event_kind = 'debit';
CREATE UNIQUE INDEX IF NOT EXISTS catalog_count_history_result_idx
  ON catalog_scope_sync_count_history (debit_id) WHERE event_kind = 'result';`;

export const catalogCountHistorySchemaMigrations = [
  {
    migrationId: "catalog-scope-sync-count-history-v1",
    description: "Retain append-only count quotes, approvals, debits, results and usage authority.",
    // Ledgered as shipped; the current boot table above supersedes it on new databases.
    statements: [
      `CREATE TABLE IF NOT EXISTS catalog_scope_sync_count_history (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  account_slot text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('usage', 'quoted', 'approved', 'debit', 'result')),
  quote_id text NULL,
  query_key text NULL,
  debit_id text NULL,
  scope_record_id text NULL,
  count_kind text NULL CHECK (count_kind IN ('cards', 'sealed')),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);`,
    ],
  },
  {
    migrationId: "catalog-scope-sync-count-history-v2-quote-allocation",
    description: "Admit whole-quote allocation and allocation-end events into retained count history.",
    // Replaces the shipped inline check, which PostgreSQL named after its column;
    // boot declares the same named constraint, so both paths converge.
    statements: [
      "SET lock_timeout = '5s'",
      "ALTER TABLE catalog_scope_sync_count_history DROP CONSTRAINT IF EXISTS catalog_scope_sync_count_history_event_kind_check",
      `ALTER TABLE catalog_scope_sync_count_history ADD ${eventKindCheck} NOT VALID`,
      "ALTER TABLE catalog_scope_sync_count_history VALIDATE CONSTRAINT catalog_scope_sync_count_history_event_kind_check",
    ],
  },
];
