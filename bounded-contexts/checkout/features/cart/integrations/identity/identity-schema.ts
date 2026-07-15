export const checkoutSellerAccountsSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_seller_accounts (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  slug text NOT NULL,
  average_rating numeric NULL,
  review_count integer NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE checkout_seller_accounts
  ADD COLUMN IF NOT EXISTS average_rating numeric NULL,
  ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS checkout_ship_from_addresses (
  shipping_address_id text PRIMARY KEY,
  account_id text NOT NULL,
  label text NOT NULL,
  recipient_name text NOT NULL,
  company text NULL,
  line1 text NOT NULL,
  line2 text NULL,
  city text NOT NULL,
  state text NOT NULL,
  postal_code text NOT NULL,
  country text NOT NULL,
  phone text NULL,
  email text NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkout_ship_from_addresses_account_default_idx
  ON checkout_ship_from_addresses (account_id, is_default DESC, updated_at DESC)
  WHERE is_archived = false;
`;
