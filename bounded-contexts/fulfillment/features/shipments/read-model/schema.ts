import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const fulfillmentShipmentLinePackingConfirmedQuantityBackfillSql = `UPDATE fulfillment_shipment_line_pages
SET packing_confirmed_quantity = quantity
WHERE packing_confirmed_quantity = 0
  AND packing_confirmed_at IS NOT NULL;`;

const fulfillmentPostageLabelOperationsStatusConstraintSql = `ALTER TABLE fulfillment_postage_label_operations
  DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_status_check;

ALTER TABLE fulfillment_postage_label_operations
  ADD CONSTRAINT fulfillment_postage_label_operations_status_check
  CHECK (status IN ('pending', 'provider-succeeded', 'succeeded', 'failed')) NOT VALID;

ALTER TABLE fulfillment_postage_label_operations
  VALIDATE CONSTRAINT fulfillment_postage_label_operations_status_check;`;

const fulfillmentPostageLabelOperationsDuplicateActiveBackfillSql = `WITH duplicate_active_operations AS (
  SELECT
    operation_key,
    ROW_NUMBER() OVER (
      PARTITION BY shipment_id, operation_kind
      ORDER BY updated_at ASC, operation_key ASC
    ) AS duplicate_rank
  FROM fulfillment_postage_label_operations
  WHERE status IN ('pending', 'provider-succeeded')
)
UPDATE fulfillment_postage_label_operations AS operation
SET status = 'failed',
    error_message = COALESCE(
      operation.error_message,
      'Superseded duplicate active postage operation during idempotency fence migration.'
    ),
    completed_at = COALESCE(operation.completed_at, now()),
    updated_at = now()
FROM duplicate_active_operations AS duplicate
WHERE operation.operation_key = duplicate.operation_key
  AND duplicate.duplicate_rank > 1;`;

const fulfillmentPostageLabelOperationsActiveKindIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_postage_label_operations_active_kind_idx
  ON fulfillment_postage_label_operations (shipment_id, operation_kind)
  WHERE status IN ('pending', 'provider-succeeded');`;

const fulfillmentShipmentPostageLabelDuplicateBackfillSql = `WITH duplicate_postage_labels AS (
  SELECT
    shipment_id,
    ROW_NUMBER() OVER (
      PARTITION BY postage_provider_name, postage_provider_label_id
      ORDER BY updated_at DESC, shipment_id DESC
    ) AS duplicate_rank
  FROM fulfillment_shipment_pages
  WHERE postage_provider_label_id IS NOT NULL
)
UPDATE fulfillment_shipment_pages AS shipment
SET postage_provider_label_id = NULL
FROM duplicate_postage_labels AS duplicate
WHERE shipment.shipment_id = duplicate.shipment_id
  AND duplicate.duplicate_rank > 1;`;

const fulfillmentShipmentPostageLabelProviderUniqueIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_shipment_pages_postage_label_idx
  ON fulfillment_shipment_pages (postage_provider_name, postage_provider_label_id)
  WHERE postage_provider_label_id IS NOT NULL;`;

const fulfillmentShipmentDisplayReferenceUniqueIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_shipment_pages_display_reference_key
  ON fulfillment_shipment_pages (display_reference)
  WHERE display_reference <> '';`;

export const fulfillmentShipmentSchemaSql = `
CREATE TABLE IF NOT EXISTS fulfillment_shipment_pages (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  shipping_option text NOT NULL,
  shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_method text NULL,
  carrier_name text NULL,
  display_reference text NOT NULL DEFAULT '',
  label_reference text NULL,
  label_document_url text NULL,
  tracking_identifier text NULL,
  postage_provider_name text NULL,
  postage_provider_mode text NULL,
  postage_provider_shipment_id text NULL,
  postage_provider_label_id text NULL,
  postage_rate_id text NULL,
  postage_service_level text NULL,
  postage_amount_cents integer NULL,
  postage_currency text NULL,
  label_status text NOT NULL DEFAULT 'not-purchased',
  label_error_code text NULL,
  label_error_message text NULL,
  label_refund_status text NULL,
  label_refund_reference text NULL,
  status text NOT NULL,
  package_status text NOT NULL,
  package_count integer NULL,
  current_exception_type text NULL,
  current_exception_notes text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  packing_started_at timestamptz NULL,
  package_prepared_at timestamptz NULL,
  label_attached_at timestamptz NULL,
  label_voided_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  exception_raised_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_shipment_pages_order_idx
  ON fulfillment_shipment_pages (order_id);

CREATE INDEX IF NOT EXISTS fulfillment_shipment_pages_buyer_idx
  ON fulfillment_shipment_pages (buyer_account_id, updated_at DESC, shipment_id DESC);

CREATE INDEX IF NOT EXISTS fulfillment_shipment_pages_seller_idx
  ON fulfillment_shipment_pages (seller_account_id, updated_at DESC, shipment_id DESC);

CREATE TABLE IF NOT EXISTS fulfillment_shipment_line_pages (
  shipment_id text NOT NULL REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE,
  line_id text NOT NULL,
  line_index integer NOT NULL,
  order_line_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  product_summary text NULL,
  quantity integer NOT NULL,
  packing_confirmed_quantity integer NOT NULL DEFAULT 0,
  packing_confirmed_at timestamptz NULL,
  PRIMARY KEY (shipment_id, line_id)
);

CREATE TABLE IF NOT EXISTS fulfillment_shipment_exception_pages (
  shipment_id text NOT NULL REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE,
  raised_at timestamptz NOT NULL,
  exception_type text NOT NULL,
  notes text NULL,
  PRIMARY KEY (shipment_id, raised_at)
);

ALTER TABLE IF EXISTS fulfillment_shipment_pages
  ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS label_document_url text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_name text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_mode text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_shipment_id text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_label_id text NULL,
  ADD COLUMN IF NOT EXISTS postage_rate_id text NULL,
  ADD COLUMN IF NOT EXISTS postage_service_level text NULL,
  ADD COLUMN IF NOT EXISTS postage_amount_cents integer NULL,
  ADD COLUMN IF NOT EXISTS postage_currency text NULL,
  ADD COLUMN IF NOT EXISTS label_status text NOT NULL DEFAULT 'not-purchased',
  ADD COLUMN IF NOT EXISTS label_error_code text NULL,
  ADD COLUMN IF NOT EXISTS label_error_message text NULL,
  ADD COLUMN IF NOT EXISTS label_refund_status text NULL,
  ADD COLUMN IF NOT EXISTS label_refund_reference text NULL,
  ADD COLUMN IF NOT EXISTS packing_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS label_voided_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS display_reference text NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS fulfillment_shipment_line_pages
  ADD COLUMN IF NOT EXISTS packing_confirmed_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packing_confirmed_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS fulfillment_label_address_override_audit_pages (
  shipment_id text NOT NULL REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  changed_side text NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  original_sender_snapshot jsonb NOT NULL,
  submitted_sender_address jsonb NOT NULL,
  original_recipient_snapshot jsonb NOT NULL,
  submitted_recipient_address jsonb NOT NULL,
  PRIMARY KEY (shipment_id, recorded_at)
);

CREATE TABLE IF NOT EXISTS fulfillment_postage_label_operations (
  operation_key text PRIMARY KEY,
  operation_kind text NOT NULL CHECK (operation_kind IN ('purchase-usps-label', 'void-label')),
  shipment_id text NOT NULL,
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

CREATE INDEX IF NOT EXISTS fulfillment_postage_label_operations_status_idx
  ON fulfillment_postage_label_operations (status, updated_at);

CREATE TABLE IF NOT EXISTS fulfillment_postage_provider_events (
  provider_event_id text PRIMARY KEY,
  provider_name text NOT NULL,
  provider_mode text NOT NULL,
  event_kind text NOT NULL,
  provider_object_reference text NOT NULL,
  shipment_id text NULL,
  tracking_identifier text NULL,
  status text NULL,
  status_detail text NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  processing_result text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS fulfillment_postage_provider_events_shipment_idx
  ON fulfillment_postage_provider_events (shipment_id, occurred_at DESC)
  WHERE shipment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fulfillment_postage_provider_events_received_idx
  ON fulfillment_postage_provider_events (received_at DESC);
`;

export const fulfillmentShipmentSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260703_fulfillment_shipment_line_packing_confirmed_quantity",
    description: "Backfill packing-confirmed quantities for existing shipment line read models.",
    statements: [fulfillmentShipmentLinePackingConfirmedQuantityBackfillSql],
  },
  {
    migrationId: "20260703_fulfillment_postage_label_operation_active_fence",
    description: "Normalize postage label operation status checks and active-operation uniqueness.",
    statements: [
      `SET lock_timeout = '5s'`,
      fulfillmentPostageLabelOperationsStatusConstraintSql,
      fulfillmentPostageLabelOperationsDuplicateActiveBackfillSql,
      fulfillmentPostageLabelOperationsActiveKindIndexSql,
    ],
  },
  {
    migrationId: "20260710_fulfillment_shipment_postage_label_provider_uniqueness",
    description:
      "Clear duplicate provider label ids and enforce provider-scoped uniqueness for purchased postage labels.",
    statements: [
      fulfillmentShipmentPostageLabelDuplicateBackfillSql,
      fulfillmentShipmentPostageLabelProviderUniqueIndexSql,
    ],
  },
  {
    migrationId: "20260711_fulfillment_shipment_display_reference_unique_idx",
    description:
      "Add the support-safe shipment display reference unique index outside boot-time schema SQL. Rows written " +
      "before this migration ran keep the empty-string default and are excluded from the uniqueness check; the " +
      "projector always populates a real reference for every shipment it creates.",
    statements: [`SET lock_timeout = '5s'`, fulfillmentShipmentDisplayReferenceUniqueIndexSql],
  },
];
