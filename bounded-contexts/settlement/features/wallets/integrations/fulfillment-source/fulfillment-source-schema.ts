import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const settlementMarketplaceLabelPostageActivationTableSql = `CREATE TABLE IF NOT EXISTS settlement_marketplace_label_postage_activation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  policy_version text NOT NULL,
  activated_at timestamptz NOT NULL
);`;

const settlementMarketplaceLabelPostageTableSql = `CREATE UNLOGGED TABLE IF NOT EXISTS settlement_marketplace_label_postage (
  shipment_id text NOT NULL,
  label_identity text NOT NULL,
  postage_provider_label_id text NULL,
  source_event_id text NOT NULL,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  postage_amount_cents integer NULL,
  postage_currency text NULL,
  outcome text NOT NULL
    CHECK (outcome IN (
      'debit-posted',
      'skipped-historical',
      'skipped-null-amount',
      'refused-currency-mismatch',
      'refused-invalid-amount',
      'refused-missing-provider-label-id'
    )),
  refusal_reason text NULL,
  operator_review_required boolean NOT NULL DEFAULT false,
  debit_ledger_entry_id text NULL,
  refund_ledger_entry_id text NULL,
  refund_reference text NULL,
  refund_status text NULL,
  policy_version text NOT NULL,
  source_recorded_at timestamptz NOT NULL,
  label_attached_at timestamptz NOT NULL,
  refunded_at timestamptz NULL,
  last_stream_version integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (shipment_id, label_identity),
  UNIQUE (source_event_id),
  CHECK ((outcome = 'debit-posted') = (debit_ledger_entry_id IS NOT NULL)),
  CHECK ((refund_ledger_entry_id IS NULL) = (refunded_at IS NULL))
);`;

// Fresh boot creates these indexes on the empty table in the same schema batch.
const settlementMarketplaceLabelPostageProviderIdentityIndexSql = `CREATE UNIQUE INDEX IF NOT EXISTS settlement_marketplace_label_postage_provider_identity_idx
  ON settlement_marketplace_label_postage (shipment_id, postage_provider_label_id)
  WHERE postage_provider_label_id IS NOT NULL;`;

const settlementMarketplaceLabelPostageOperatorReviewIndexSql = `CREATE INDEX IF NOT EXISTS settlement_marketplace_label_postage_operator_review_idx
  ON settlement_marketplace_label_postage (updated_at, shipment_id)
  WHERE operator_review_required;`;

const settlementMarketplaceLabelPostageProviderIdentityMigrationIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS settlement_marketplace_label_postage_provider_identity_idx
  ON settlement_marketplace_label_postage (shipment_id, postage_provider_label_id)
  WHERE postage_provider_label_id IS NOT NULL;`;

const settlementMarketplaceLabelPostageOperatorReviewMigrationIndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_marketplace_label_postage_operator_review_idx
  ON settlement_marketplace_label_postage (updated_at, shipment_id)
  WHERE operator_review_required;`;

export const settlementFulfillmentSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_order_fulfillment_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  status text NOT NULL,
  tracking_identifier text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  exception_raised_at timestamptz NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_order_fulfillment_sources_order_idx
  ON settlement_order_fulfillment_sources (order_id, seller_account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS settlement_order_fulfillment_sources_seller_idx
  ON settlement_order_fulfillment_sources (seller_account_id, updated_at DESC);

${settlementMarketplaceLabelPostageActivationTableSql}

${settlementMarketplaceLabelPostageTableSql}

${settlementMarketplaceLabelPostageProviderIdentityIndexSql}

${settlementMarketplaceLabelPostageOperatorReviewIndexSql}
`;

export const settlementFulfillmentSourceSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260910_settlement_marketplace_label_postage",
    description: "Create the worker activation authority and replayable marketplace label postage projection.",
    statements: [
      "SET lock_timeout = '5s';",
      settlementMarketplaceLabelPostageActivationTableSql,
      settlementMarketplaceLabelPostageTableSql,
      settlementMarketplaceLabelPostageProviderIdentityMigrationIndexSql,
      settlementMarketplaceLabelPostageOperatorReviewMigrationIndexSql,
    ],
  },
];
