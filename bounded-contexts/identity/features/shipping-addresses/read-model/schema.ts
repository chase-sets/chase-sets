export const identityShippingAddressSchemaSql = `CREATE TABLE IF NOT EXISTS identity_shipping_addresses (
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
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS identity_shipping_addresses_account_idx
  ON identity_shipping_addresses (account_id, is_archived, is_default DESC, updated_at DESC);`;
