export const checkoutPaymentSummarySchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_payment_summary_pages (
  payment_id text PRIMARY KEY,
  buyer_account_id text NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount text NOT NULL,
  currency_code text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS checkout_payment_summary_pages_buyer_account_idx
  ON checkout_payment_summary_pages (buyer_account_id, updated_at DESC)
  WHERE buyer_account_id IS NOT NULL;
`;
