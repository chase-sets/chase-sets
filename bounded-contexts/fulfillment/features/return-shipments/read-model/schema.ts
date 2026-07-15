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
  label_status text NOT NULL DEFAULT 'pending',
  carrier_name text NULL,
  tracking_identifier text NULL,
  label_document_url text NULL,
  label_failure_reason text NULL,
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
  label_document_url text NULL,
  carrier_name text NULL,
  tracking_identifier text NULL,
  postage_provider_name text NULL,
  postage_provider_mode text NULL,
  postage_provider_shipment_id text NULL,
  postage_provider_label_id text NULL,
  postage_amount_cents integer NULL,
  estimated_postage_amount_cents integer NULL,
  postage_currency text NULL,
  label_failure_reason text NULL,
  label_failure_detail text NULL,
  label_refund_status text NULL,
  label_refund_reference text NULL,
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
  facility_intake jsonb NULL,
  intake_corrections jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_intake_scan_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL,
  label_ready_at timestamptz NULL,
  label_failed_at timestamptz NULL,
  label_voided_at timestamptz NULL,
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

CREATE TABLE IF NOT EXISTS fulfillment_return_shipment_label_operations (
  operation_key text PRIMARY KEY,
  operation_kind text NOT NULL CHECK (operation_kind IN ('purchase-label', 'void-label')),
  return_shipment_id text NOT NULL,
  remedy_id text NOT NULL,
  provider_name text NOT NULL,
  provider_mode text NOT NULL,
  idempotency_key text NOT NULL,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'provider-succeeded', 'succeeded', 'failed')),
  provider_shipment_id text NULL,
  provider_label_id text NULL,
  tracking_identifier text NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_return_shipment_label_operations_status_idx
  ON fulfillment_return_shipment_label_operations (status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_return_shipment_label_operations_active_kind_idx
  ON fulfillment_return_shipment_label_operations (return_shipment_id, operation_kind)
  WHERE status IN ('pending', 'provider-succeeded');

CREATE INDEX IF NOT EXISTS fulfillment_return_shipment_operator_pages_tracking_idx
  ON fulfillment_return_shipment_operator_pages (tracking_identifier)
  WHERE tracking_identifier IS NOT NULL;

CREATE INDEX IF NOT EXISTS fulfillment_return_shipment_operator_pages_facility_status_idx
  ON fulfillment_return_shipment_operator_pages (facility_id, status, delivered_at, return_shipment_id);

CREATE TABLE IF NOT EXISTS fulfillment_unidentified_return_package_pages (
  unidentified_package_id text PRIMARY KEY,
  facility_id text NOT NULL,
  station_id text NOT NULL,
  operator_user_id text NOT NULL,
  received_at timestamptz NOT NULL,
  package_condition text NOT NULL,
  seal_condition text NOT NULL,
  measured_weight_ounces numeric NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  custody_identifier text NOT NULL UNIQUE,
  notes text NULL,
  owner text NOT NULL,
  next_action text NOT NULL,
  return_shipment_id text NULL,
  reconciled_by_user_id text NULL,
  reconciled_at timestamptz NULL,
  reconciliation_reason text NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_unidentified_return_package_pages_facility_status_idx
  ON fulfillment_unidentified_return_package_pages (facility_id, reconciled_at, received_at DESC);
`;

export const fulfillmentReturnShipmentSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260714_fulfillment_return_shipment_facility_intake",
    description:
      "Add facility intake evidence, duplicate-scan metrics, and unidentified package reconciliation read models.",
    statements: [
      `ALTER TABLE IF EXISTS fulfillment_return_shipment_operator_pages
         ADD COLUMN IF NOT EXISTS facility_intake jsonb NULL,
         ADD COLUMN IF NOT EXISTS intake_corrections jsonb NOT NULL DEFAULT '[]'::jsonb,
         ADD COLUMN IF NOT EXISTS duplicate_intake_scan_count integer NOT NULL DEFAULT 0`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_return_shipment_operator_pages_tracking_idx
         ON fulfillment_return_shipment_operator_pages (tracking_identifier)
         WHERE tracking_identifier IS NOT NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_return_shipment_operator_pages_facility_status_idx
         ON fulfillment_return_shipment_operator_pages (facility_id, status, delivered_at, return_shipment_id)`,
      `CREATE TABLE IF NOT EXISTS fulfillment_unidentified_return_package_pages (
         unidentified_package_id text PRIMARY KEY,
         facility_id text NOT NULL,
         station_id text NOT NULL,
         operator_user_id text NOT NULL,
         received_at timestamptz NOT NULL,
         package_condition text NOT NULL,
         seal_condition text NOT NULL,
         measured_weight_ounces numeric NULL,
         evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
         custody_identifier text NOT NULL UNIQUE,
         notes text NULL,
         owner text NOT NULL,
         next_action text NOT NULL,
         return_shipment_id text NULL,
         reconciled_by_user_id text NULL,
         reconciled_at timestamptz NULL,
         reconciliation_reason text NULL,
         updated_at timestamptz NOT NULL
       )`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_unidentified_return_package_pages_facility_status_idx
         ON fulfillment_unidentified_return_package_pages (facility_id, reconciled_at, received_at DESC)`,
    ],
  },
];
