export const checkoutSellerAccountsSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_seller_accounts (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  slug text NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
