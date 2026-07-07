export const paymentsDisputeEvidenceSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_fulfillment_dispute_evidence_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  status text NOT NULL,
  shipping_method text NULL,
  carrier_name text NULL,
  tracking_identifier text NULL,
  shipping_destination_snapshot jsonb NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  label_attached_at timestamptz NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_fulfillment_dispute_evidence_sources_order_idx
  ON payments_fulfillment_dispute_evidence_sources (order_id, updated_at DESC);
`;

export const paymentsDisputeEvidenceSourceSchemaMigrations = [
  {
    migrationId: "20260706_payments_fulfillment_dispute_evidence_sources",
    description: "Add Payments-owned Fulfillment evidence source mirror for automatic dispute evidence assembly.",
    statements: [
      `CREATE TABLE IF NOT EXISTS payments_fulfillment_dispute_evidence_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  status text NOT NULL,
  shipping_method text NULL,
  carrier_name text NULL,
  tracking_identifier text NULL,
  shipping_destination_snapshot jsonb NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  label_attached_at timestamptz NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  updated_at timestamptz NOT NULL
)`,
      `CREATE INDEX IF NOT EXISTS payments_fulfillment_dispute_evidence_sources_order_idx
  ON payments_fulfillment_dispute_evidence_sources (order_id, updated_at DESC)`,
    ],
  },
] as const;
