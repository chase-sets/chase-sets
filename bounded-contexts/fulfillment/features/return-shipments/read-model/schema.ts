import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

/**
 * Two separately projected read models for the ReturnShipment aggregate.
 *
 * - `fulfillment_return_shipment_customer_pages` is the customer-safe surface. It
 *   deliberately omits the facility postal address, facility id/version, the
 *   ship-from party address, operational routing, and cost allocation. A customer
 *   query can only read this table, so protected facility/party metadata cannot
 *   leak by construction.
 * - `fulfillment_return_shipment_operator_pages` is the operator evidence surface.
 *   It carries the immutable destination snapshot, party snapshot, custody
 *   timeline, exceptions, deadlines, and cost payer so operators can resolve
 *   exceptions without joining another context's database.
 *
 * `status` columns are intentionally unconstrained text (populated only by this
 * projector) to avoid coupling the read schema to the domain enum.
 */
export const fulfillmentReturnShipmentSchemaSql = `
CREATE TABLE IF NOT EXISTS fulfillment_return_shipment_customer_pages (
  return_shipment_id text PRIMARY KEY,
  remedy_id text NOT NULL,
  status text NOT NULL,
  carrier_name text NULL,
  tracking_identifier text NULL,
  destination_display_name text NOT NULL,
  destination_display_instructions text NOT NULL,
  destination_region text NOT NULL,
  destination_city text NOT NULL,
  destination_state text NOT NULL,
  ship_by_deadline_at timestamptz NOT NULL,
  return_by_deadline_at timestamptz NOT NULL,
  current_exception_type text NULL,
  requested_at timestamptz NOT NULL,
  delivered_at timestamptz NULL,
  received_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  return_expired_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_return_shipment_customer_pages_remedy_idx
  ON fulfillment_return_shipment_customer_pages (remedy_id);

CREATE TABLE IF NOT EXISTS fulfillment_return_shipment_operator_pages (
  return_shipment_id text PRIMARY KEY,
  remedy_id text NOT NULL,
  support_request_id text NOT NULL,
  order_id text NOT NULL,
  outbound_shipment_id text NOT NULL,
  return_directive text NOT NULL,
  status text NOT NULL,
  ship_from_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  facility_id text NOT NULL,
  facility_config_version text NOT NULL,
  selection_policy_version text NOT NULL,
  package_requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  label_status text NOT NULL,
  label_provider_reference text NULL,
  carrier_name text NULL,
  tracking_identifier text NULL,
  cost_payer text NOT NULL,
  cost_allocation_reference text NULL,
  ship_by_deadline_at timestamptz NOT NULL,
  return_by_deadline_at timestamptz NOT NULL,
  policy_version text NOT NULL,
  idempotency_key text NOT NULL,
  current_exception_type text NULL,
  current_exception_notes text NULL,
  milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_at timestamptz NOT NULL,
  label_ready_at timestamptz NULL,
  carrier_accepted_at timestamptz NULL,
  delivered_at timestamptz NULL,
  received_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  return_expired_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_return_shipment_operator_pages_remedy_idx
  ON fulfillment_return_shipment_operator_pages (remedy_id);

CREATE INDEX IF NOT EXISTS fulfillment_return_shipment_operator_pages_status_idx
  ON fulfillment_return_shipment_operator_pages (status, updated_at DESC, return_shipment_id DESC);
`;

export const fulfillmentReturnShipmentSchemaMigrations: readonly BcSchemaMigration[] = [];
