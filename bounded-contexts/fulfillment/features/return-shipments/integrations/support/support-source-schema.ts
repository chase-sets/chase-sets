export const fulfillmentSupportReturnSourceSchemaSql = `
CREATE UNLOGGED TABLE IF NOT EXISTS fulfillment_support_return_sources (
  support_request_id text PRIMARY KEY,
  order_id text NOT NULL,
  affected_order_line_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_support_return_sources_order_idx
  ON fulfillment_support_return_sources (order_id, support_request_id);

CREATE UNLOGGED TABLE IF NOT EXISTS fulfillment_support_return_remedy_sources (
  remedy_id text PRIMARY KEY,
  support_request_id text NOT NULL,
  return_directive text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_support_return_remedy_sources_case_idx
  ON fulfillment_support_return_remedy_sources (support_request_id, remedy_id);
`;
