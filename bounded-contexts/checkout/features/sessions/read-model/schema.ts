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
  authenticity_check_opt_in jsonb NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_write_commit_positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  checkout_reservations jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_id text NULL,
  submitted_offer_id text NULL,
  cancelled_at timestamptz NULL,
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
    // A single ADD COLUMN ... NOT NULL DEFAULT is a metadata-only change in PostgreSQL 11+
    // (no table rewrite, no full scan) that holds ACCESS EXCLUSIVE only for an instant. The
    // previous ADD (nullable) -> UPDATE -> SET DEFAULT -> SET NOT NULL sequence held
    // ACCESS EXCLUSIVE across a full-table validation scan, so under live read traffic each
    // statement repeatedly hit lock_timeout and the schema-bootstrap retry loop span silently
    // until the deploy quiesce killed it. See #4638.
    statements: [
      `ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS checkout_reservations jsonb NOT NULL DEFAULT '[]'::jsonb;`,
    ],
  },
  {
    migrationId: "20260708_checkout_session_cancellation",
    description: "Add checkout session cancellation timestamp for terminal session state.",
    statements: [
      `ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL;`,
    ],
  },
  {
    migrationId: "20260711_checkout_session_authenticity_opt_in",
    description: "Add the buyer authenticity-check opt-in snapshot to checkout session pages.",
    statements: [
      `ALTER TABLE checkout_session_pages
  ADD COLUMN IF NOT EXISTS authenticity_check_opt_in jsonb NULL;`,
    ],
  },
];
