export const checkoutSessionSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_session_pages (
  session_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  source_type text NOT NULL,
  optimization_goal text NOT NULL DEFAULT 'lowest-total',
  fulfillment_preview_revision text NULL,
  shipping_option text NOT NULL,
  shipping_address jsonb NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_id text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS checkout_session_pages_buyer_idx
  ON checkout_session_pages (buyer_account_id, updated_at DESC, session_id DESC);

ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS shipping_address jsonb NULL;

ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS optimization_goal text NOT NULL DEFAULT 'lowest-total',
  ADD COLUMN IF NOT EXISTS fulfillment_preview_revision text NULL;
`;
