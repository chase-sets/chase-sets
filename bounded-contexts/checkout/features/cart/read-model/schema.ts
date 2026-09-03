import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

// ECMAScript WhiteSpace + LineTerminator (the command's /\s/): TAB, VT, FF,
// ZWNBSP, Unicode Space_Separator, LF, CR, LS and PS. Enumerate each code point
// with PostgreSQL U& escapes; POSIX space classes and ranges depend on locale.
// https://tc39.es/ecma262/#sec-white-space
const checkoutCartClaimWhitespaceSql =
  String.raw`\0009\000A\000B\000C\000D\0020\00A0\1680` +
  String.raw`\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A` +
  String.raw`\2028\2029\202F\205F\3000\FEFF`;

// Cart Claim ownership alias. This is the operational projection of the
// `checkout.cart.claimed-by-account` event, not the authority for it: the
// source stream's event history decides ownership, and this table only makes a
// claimed key cheap to resolve from the claiming Account. It stays logged --
// unlike the replayable line pages -- because a claim is written synchronously
// on the command path and read back in the same request.
//
// The CHECK constraints repeat the command's exact identity rules so a row that
// contradicts them cannot be inserted by any path, including a replay of a
// malformed historical event.
export const checkoutCartClaimsTableSchemaSql = `CREATE TABLE IF NOT EXISTS checkout_cart_claims (
  source_owner_key text NOT NULL,
  account_id text NOT NULL,
  PRIMARY KEY (source_owner_key),
  CONSTRAINT checkout_cart_claims_source_owner_key_check CHECK (source_owner_key ~ U&'^anon_[^${checkoutCartClaimWhitespaceSql}]+$'),
  CONSTRAINT checkout_cart_claims_account_id_check CHECK (account_id ~ U&'^acc_[^${checkoutCartClaimWhitespaceSql}]+$')
);`;

const checkoutCartClaimsAccountIndexSql = `CREATE INDEX IF NOT EXISTS checkout_cart_claims_account_idx
  ON checkout_cart_claims (account_id, source_owner_key);`;

export const checkoutCartSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_cart_line_pages (
  buyer_account_id text NOT NULL,
  line_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_language_code text NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  item_image_url text NULL,
  item_image_srcset text NULL,
  item_image_loading_url text NULL,
  item_image_loading_alt text NULL,
  item_image_loading_srcset text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  fulfillment_mode text NOT NULL DEFAULT 'optimize',
  locked_listing_id text NULL,
  selected_listing_id text NULL,
  selected_listing_seller_account_id text NULL,
  selected_listing_seller_display_name text NULL,
  selected_listing_seller_slug text NULL,
  selected_listing_price_amount numeric(12, 2) NULL,
  selected_listing_snapshot_source text NULL,
  selected_listing_snapshot_captured_at timestamptz NULL,
  seller_preference_id text NULL,
  availability_state text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_account_id, line_id)
);

ALTER TABLE checkout_cart_line_pages
  ADD COLUMN IF NOT EXISTS selected_listing_id text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_seller_account_id text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_seller_display_name text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_seller_slug text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_price_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_snapshot_source text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_snapshot_captured_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS checkout_cart_line_pages_buyer_idx
  ON checkout_cart_line_pages (buyer_account_id, updated_at DESC, line_id ASC);

CREATE INDEX IF NOT EXISTS checkout_cart_line_pages_catalog_version_idx
  ON checkout_cart_line_pages (product_id);

${checkoutCartClaimsTableSchemaSql}

${checkoutCartClaimsAccountIndexSql}
`;

// Fresh boots create the claims table and index from the shared definitions
// above; databases created before Cart Claim converge through this ledger entry
// instead of silently keeping the old shape. The index is created CONCURRENTLY
// here because a long-lived database applies this while serving traffic, while
// the fresh-boot copy runs against a table that does not exist yet.
export const checkoutCartSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260903_checkout_cart_claims",
    description: "Create the logged Cart Claim ownership alias table and its Account lookup index.",
    statements: [
      checkoutCartClaimsTableSchemaSql,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_cart_claims_account_idx
  ON checkout_cart_claims (account_id, source_owner_key);`,
    ],
  },
];
