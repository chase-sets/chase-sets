export const checkoutPaymentAffordanceSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_payment_affordance_account_snapshots (
  account_id text PRIMARY KEY,
  published_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checkout_payment_affordance_pages (
  account_id text NOT NULL,
  instrument_id text NOT NULL,
  payment_method_category text NOT NULL,
  display_label text NOT NULL,
  confirmation_experience text NOT NULL,
  readiness text NOT NULL,
  checkout_eligible boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  removed_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, instrument_id)
);

CREATE INDEX IF NOT EXISTS checkout_payment_affordance_pages_account_ready_idx
  ON checkout_payment_affordance_pages (account_id, is_default DESC, updated_at DESC)
  WHERE checkout_eligible = true;
`;
