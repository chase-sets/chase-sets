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

CREATE INDEX IF NOT EXISTS checkout_seller_account_reviews_subject_idx
  ON checkout_seller_account_reviews (subject_account_id, status);
`;
