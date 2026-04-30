export const settlementPayoutReadinessSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_payout_readiness_pages (
  account_id text PRIMARY KEY,
  status text NOT NULL,
  missing_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_reference text NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_payout_readiness_pages_status_idx
  ON settlement_payout_readiness_pages (status, updated_at DESC, account_id DESC);
`;
