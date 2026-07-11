import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const checkoutSellerAccountReviewsSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_seller_account_reviews (
  review_id text PRIMARY KEY,
  subject_account_id text NOT NULL,
  author_role text NOT NULL DEFAULT '',
  rating integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_stream_version integer NOT NULL DEFAULT 0,
  submitted_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE checkout_seller_account_reviews
  ADD COLUMN IF NOT EXISTS author_role text NOT NULL DEFAULT '';

-- Double-blind reveal (m108): a review contributes to
-- checkout_seller_accounts reputation counters only once revealed_at is set.
ALTER TABLE checkout_seller_account_reviews
  ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS checkout_seller_account_reviews_subject_idx
  ON checkout_seller_account_reviews (subject_account_id, status);
`;

export const checkoutSellerAccountReviewsSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260711_checkout_seller_account_reviews_reveal",
    description:
      "Add the revealed_at gate to checkout_seller_account_reviews and mark every existing (pre-launch) row revealed (m108).",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE checkout_seller_account_reviews ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL`,
      `UPDATE checkout_seller_account_reviews
   SET revealed_at = updated_at
   WHERE status = 'active'
     AND revealed_at IS NULL`,
    ],
  },
] as const;
