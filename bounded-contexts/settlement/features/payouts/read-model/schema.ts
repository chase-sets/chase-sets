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
  scheduled_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  sent_at timestamptz NULL,
  completed_at timestamptz NULL,
  failed_at timestamptz NULL,
  failure_reason text NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_payout_pages_account_idx
  ON settlement_payout_pages (account_id, updated_at DESC, payout_id DESC);

CREATE INDEX IF NOT EXISTS settlement_payout_pages_provider_payout_idx
  ON settlement_payout_pages (provider_payout_reference)
  WHERE provider_payout_reference IS NOT NULL;

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
`;
