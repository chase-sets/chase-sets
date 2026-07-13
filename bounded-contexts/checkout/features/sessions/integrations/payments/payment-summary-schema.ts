import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const checkoutPaymentSummarySchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_payment_summary_pages (
  payment_id text PRIMARY KEY,
  buyer_account_id text NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount text NOT NULL,
  currency_code text NOT NULL,
  processor_client_secret text NULL,
  status text NOT NULL,
  created_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS checkout_payment_summary_pages_buyer_account_idx
  ON checkout_payment_summary_pages (buyer_account_id, updated_at DESC)
  WHERE buyer_account_id IS NOT NULL;

ALTER TABLE checkout_payment_summary_pages
  ADD COLUMN IF NOT EXISTS processor_client_secret text NULL;
`;

export const checkoutPaymentSummarySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260712_checkout_payment_confirmation",
    description: "Add processor confirmation state to Checkout's local payment projection.",
    statements: [
      `ALTER TABLE checkout_payment_summary_pages
  ADD COLUMN IF NOT EXISTS processor_client_secret text NULL;`,
    ],
  },
];
