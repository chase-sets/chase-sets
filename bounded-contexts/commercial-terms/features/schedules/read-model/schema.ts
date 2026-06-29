export const scheduleSchemaSql = `
CREATE TABLE IF NOT EXISTS commercial_terms_schedule_pages (
  schedule_id text PRIMARY KEY,
  label text NOT NULL,
  account_type text NOT NULL,
  marketplace_sales_fee_percentage_bps integer NOT NULL,
  marketplace_sales_fee_fixed_amount numeric(12,2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  status text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commercial_terms_schedule_pages_account_type_idx
  ON commercial_terms_schedule_pages (account_type, effective_from DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS commercial_terms_schedule_history (
  history_id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  schedule_id text NOT NULL,
  event_type text NOT NULL,
  actor_user_id text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commercial_terms_schedule_history_schedule_idx
  ON commercial_terms_schedule_history (schedule_id, recorded_at DESC, history_id DESC);

ALTER TABLE commercial_terms_schedule_pages
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500;
`;
