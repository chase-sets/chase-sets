export const orderingFulfillmentSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_fulfillment_cancellation_inputs (
  order_id text PRIMARY KEY,
  shipment_id text NOT NULL,
  shipment_status text NOT NULL,
  package_status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  package_prepared_at timestamptz NULL,
  cancelled_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ordering_fulfillment_cancellation_inputs_status_idx
  ON ordering_fulfillment_cancellation_inputs (shipment_status, package_status, updated_at DESC);
`;
