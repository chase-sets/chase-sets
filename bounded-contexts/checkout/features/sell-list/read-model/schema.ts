export const checkoutSellListSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_sell_list_line_pages (
  seller_account_id text NOT NULL,
  line_id text NOT NULL,
  line_type text NOT NULL,
  offer_id text NULL,
  listing_id text NULL,
  buyer_account_id text NULL,
  buyer_display_name text NULL,
  offer_price_amount text NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  fallback_mode text NOT NULL DEFAULT 'none',
  minimum_listing_price_amount text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_account_id, line_id)
);

CREATE INDEX IF NOT EXISTS checkout_sell_list_line_pages_seller_idx
  ON checkout_sell_list_line_pages (seller_account_id, updated_at DESC, line_id ASC);

CREATE UNIQUE INDEX IF NOT EXISTS checkout_sell_list_line_pages_offer_unique_idx
  ON checkout_sell_list_line_pages (seller_account_id, offer_id)
  WHERE offer_id IS NOT NULL;

-- Self-heal columns added after the table was first created. CREATE TABLE IF NOT
-- EXISTS never alters an already-existing table, so long-lived databases (e.g. the
-- persistent staging projection store) miss later columns and every read SELECT
-- fails. These idempotent ADD COLUMN IF NOT EXISTS statements reconcile the drift on
-- schema apply. Only NULLable / DEFAULTed columns are self-healed so the ALTER
-- succeeds against populated tables.
ALTER TABLE checkout_sell_list_line_pages
  ADD COLUMN IF NOT EXISTS listing_id text NULL,
  ADD COLUMN IF NOT EXISTS buyer_display_name text NULL,
  ADD COLUMN IF NOT EXISTS offer_price_amount text NULL,
  ADD COLUMN IF NOT EXISTS item_subtitle text NULL,
  ADD COLUMN IF NOT EXISTS selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS product_summary text NULL,
  ADD COLUMN IF NOT EXISTS fallback_mode text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS minimum_listing_price_amount text NULL;

CREATE TABLE IF NOT EXISTS checkout_sell_list_confirmation_pages (
  seller_account_id text NOT NULL,
  confirmation_id text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  readiness_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  seller_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  handoff_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_account_id, confirmation_id)
);

CREATE INDEX IF NOT EXISTS checkout_sell_list_confirmation_pages_seller_latest_idx
  ON checkout_sell_list_confirmation_pages (seller_account_id, confirmed_at DESC, confirmation_id DESC);

CREATE INDEX IF NOT EXISTS checkout_sell_list_confirmation_pages_reference_idx
  ON checkout_sell_list_confirmation_pages (confirmation_id, confirmed_at DESC);

ALTER TABLE checkout_sell_list_confirmation_pages
  ADD COLUMN IF NOT EXISTS readiness_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS seller_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS handoff_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS checkout_sell_payout_readiness_pages (
  account_id text PRIMARY KEY,
  status text NOT NULL,
  missing_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS checkout_sell_payout_readiness_pages_status_idx
  ON checkout_sell_payout_readiness_pages (status, updated_at DESC, account_id DESC);

CREATE TABLE IF NOT EXISTS checkout_sell_offer_pages (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  price_amount numeric(12,2) NOT NULL,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  status text NOT NULL DEFAULT 'submitted',
  accepted_seller_account_id text NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS checkout_sell_offer_pages_product_idx
  ON checkout_sell_offer_pages (product_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS checkout_sell_offer_pages_buyer_idx
  ON checkout_sell_offer_pages (buyer_account_id, updated_at DESC);

ALTER TABLE checkout_sell_offer_pages
  ADD COLUMN IF NOT EXISTS item_subtitle text NULL,
  ADD COLUMN IF NOT EXISTS selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS product_summary text NULL,
  ADD COLUMN IF NOT EXISTS accepted_seller_account_id text NULL,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_stream_version bigint NOT NULL DEFAULT 0;
`;
