export const settlementPayoutSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_payout_pages (
  payout_id text PRIMARY KEY,
  account_id text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  destination_reference text NULL,
  note text NULL,
  status text NOT NULL,
  provider_transfer_reference text NULL,
  provider_payout_reference text NULL,
  provider_status text NULL,
  provider_failure_code text NULL,
  provider_failure_message text NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  sent_at timestamptz NULL,
  completed_at timestamptz NULL,
  failed_at timestamptz NULL,
  failure_reason text NULL,
  last_provider_event_at timestamptz NULL,
  last_reconciled_at timestamptz NULL,
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz NULL,
  retry_reason text NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_payout_pages_account_idx
  ON settlement_payout_pages (account_id, updated_at DESC, payout_id DESC);

CREATE INDEX IF NOT EXISTS settlement_payout_pages_provider_payout_idx
  ON settlement_payout_pages (provider_payout_reference)
  WHERE provider_payout_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS settlement_money_movement_webhook_events (
  provider_event_id text PRIMARY KEY,
  provider_name text NOT NULL,
  event_kind text NOT NULL,
  provider_object_reference text NULL,
  received_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_money_movement_webhook_events_received_idx
  ON settlement_money_movement_webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS settlement_provider_idempotency_keys (
  operation_key text PRIMARY KEY,
  provider_name text NOT NULL,
  operation_kind text NOT NULL,
  account_id text NULL,
  payout_id text NULL,
  provider_object_reference text NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_provider_idempotency_keys_account_idx
  ON settlement_provider_idempotency_keys (account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS settlement_reconciliation_runs (
  reconciliation_run_id text PRIMARY KEY,
  kind text NOT NULL,
  checked_count integer NOT NULL,
  reconciled_count integer NOT NULL,
  ignored_count integer NOT NULL,
  skipped_count integer NOT NULL,
  error_count integer NOT NULL,
  status text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_reconciliation_runs_completed_idx
  ON settlement_reconciliation_runs (completed_at DESC);

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS provider_transfer_reference text NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS provider_payout_reference text NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS provider_status text NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS provider_failure_code text NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS provider_failure_message text NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS last_provider_event_at timestamptz NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NULL;

ALTER TABLE settlement_payout_pages
  ADD COLUMN IF NOT EXISTS retry_reason text NULL;

ALTER TABLE settlement_money_movement_webhook_events
  ADD COLUMN IF NOT EXISTS event_kind text NULL;

ALTER TABLE settlement_money_movement_webhook_events
  ADD COLUMN IF NOT EXISTS provider_object_reference text NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'settlement_payout_pages'
      AND column_name = 'scheduled_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'settlement_payout_pages'
      AND column_name = 'requested_at'
  ) THEN
    ALTER TABLE settlement_payout_pages RENAME COLUMN scheduled_at TO requested_at;
  END IF;
END $$;
`;
