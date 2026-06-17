export const checkoutSellerAccountsSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_seller_accounts (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  slug text NOT NULL,
  average_rating numeric NULL,
  review_count integer NOT NULL DEFAULT 0,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE checkout_seller_accounts
  ADD COLUMN IF NOT EXISTS average_rating numeric NULL,
  ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0;
`;
