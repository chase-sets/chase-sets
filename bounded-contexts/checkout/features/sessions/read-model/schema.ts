import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const checkoutSessionSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_session_pages (
  session_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  source_type text NOT NULL,
  optimization_goal text NOT NULL DEFAULT 'lowest-total',
  fulfillment_preview_revision text NULL,
  fulfillment_preview_snapshot jsonb NULL,
  cart_readiness_snapshot jsonb NULL,
  split_group_handoff jsonb NULL,
  shipping_option text NOT NULL,
  shipping_address_id text NULL,
  shipping_address jsonb NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_write_commit_positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  checkout_reservations jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_id text NULL,
  submitted_offer_id text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS checkout_session_pages_buyer_idx
  ON checkout_session_pages (buyer_account_id, updated_at DESC, session_id DESC);

CREATE INDEX IF NOT EXISTS checkout_session_pages_support_reference_idx
  ON checkout_session_pages ((split_group_handoff ->> 'supportReference'), updated_at DESC)
  WHERE split_group_handoff IS NOT NULL;

CREATE INDEX IF NOT EXISTS checkout_session_pages_split_group_handoff_idx
  ON checkout_session_pages USING GIN (split_group_handoff)
  WHERE split_group_handoff IS NOT NULL;

ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS order_write_commit_positions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS fulfillment_preview_snapshot jsonb NULL;
`;

export const checkoutSessionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_checkout_session_reservations",
    description: "Add checkout session reservation snapshots for checkout inventory holds.",
    statements: [
      `ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS checkout_reservations jsonb NULL;`,
      `UPDATE checkout_session_pages
  SET checkout_reservations = '[]'::jsonb
  WHERE checkout_reservations IS NULL;`,
      `ALTER TABLE checkout_session_pages
  ALTER COLUMN checkout_reservations SET DEFAULT '[]'::jsonb;`,
      `SET lock_timeout = '5s';`,
      `ALTER TABLE checkout_session_pages
  ALTER COLUMN checkout_reservations SET NOT NULL;`,
    ],
  },
];
