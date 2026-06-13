export const checkoutSessionSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_session_pages (
  session_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  source_type text NOT NULL,
  optimization_goal text NOT NULL DEFAULT 'lowest-total',
  fulfillment_preview_revision text NULL,
  cart_readiness_snapshot jsonb NULL,
  split_group_handoff jsonb NULL,
  shipping_option text NOT NULL,
  shipping_address_id text NULL,
  shipping_address jsonb NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_id text NULL,
  submitted_offer_id text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS buyer_account_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'cart',
  ADD COLUMN IF NOT EXISTS optimization_goal text NOT NULL DEFAULT 'lowest-total',
  ADD COLUMN IF NOT EXISTS fulfillment_preview_revision text NULL,
  ADD COLUMN IF NOT EXISTS cart_readiness_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS split_group_handoff jsonb NULL,
  ADD COLUMN IF NOT EXISTS shipping_option text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS shipping_address_id text NULL,
  ADD COLUMN IF NOT EXISTS shipping_address jsonb NULL,
  ADD COLUMN IF NOT EXISTS lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_id text NULL,
  ADD COLUMN IF NOT EXISTS submitted_offer_id text NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS checkout_session_pages_buyer_idx
  ON checkout_session_pages (buyer_account_id, updated_at DESC, session_id DESC);

CREATE INDEX IF NOT EXISTS checkout_session_pages_support_reference_idx
  ON checkout_session_pages ((split_group_handoff ->> 'supportReference'), updated_at DESC)
  WHERE split_group_handoff IS NOT NULL;

CREATE INDEX IF NOT EXISTS checkout_session_pages_split_group_handoff_idx
  ON checkout_session_pages USING GIN (split_group_handoff)
  WHERE split_group_handoff IS NOT NULL;
`;
