import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const fulfillmentShipmentLinePackingConfirmedQuantityBackfillSql = `UPDATE fulfillment_shipment_line_pages
SET packing_confirmed_quantity = quantity
WHERE packing_confirmed_quantity = 0
  AND packing_confirmed_at IS NOT NULL;`;

const fulfillmentPostageLabelOperationsStatusConstraintSql = `SET LOCAL lock_timeout = '5s';

ALTER TABLE fulfillment_postage_label_operations
  DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_status_check;

ALTER TABLE fulfillment_postage_label_operations
  ADD CONSTRAINT fulfillment_postage_label_operations_status_check
  CHECK (status IN ('reserved', 'invoking', 'ambiguous', 'provider-succeeded', 'effect-applied', 'failed-safe')) NOT VALID;

ALTER TABLE fulfillment_postage_label_operations
  VALIDATE CONSTRAINT fulfillment_postage_label_operations_status_check;`;

const fulfillmentPostageLabelOperationsLegacyStatusConstraintSql = `SET LOCAL lock_timeout = '5s';

ALTER TABLE fulfillment_postage_label_operations
  DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_status_check;

ALTER TABLE fulfillment_postage_label_operations
  ADD CONSTRAINT fulfillment_postage_label_operations_status_check
  CHECK (status IN ('pending', 'provider-succeeded', 'succeeded', 'failed')) NOT VALID;

ALTER TABLE fulfillment_postage_label_operations
  VALIDATE CONSTRAINT fulfillment_postage_label_operations_status_check;`;

const fulfillmentPostageLabelOperationsDropLegacyConstraintsSql = `SET LOCAL lock_timeout = '5s';

ALTER TABLE fulfillment_postage_label_operations
  DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_status_check,
  DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_operation_kind_check;`;

const fulfillmentPostageLabelOperationsOperationKindConstraintSql = `SET LOCAL lock_timeout = '5s';

ALTER TABLE fulfillment_postage_label_operations
  ADD CONSTRAINT fulfillment_postage_label_operations_operation_kind_check
  CHECK (operation_kind IN ('purchase-usps-label', 'void-label', 'orphan-label-void')) NOT VALID;

ALTER TABLE fulfillment_postage_label_operations
  VALIDATE CONSTRAINT fulfillment_postage_label_operations_operation_kind_check;`;

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

const fulfillmentPostageLabelOperationsLegacyActiveKindIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_postage_label_operations_active_kind_idx
  ON fulfillment_postage_label_operations (shipment_id, operation_kind)
  WHERE status IN ('pending', 'provider-succeeded');`;

const fulfillmentPostageLabelOperationsActiveTargetIndexV1Sql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_postage_label_operations_active_target_v1_idx
  ON fulfillment_postage_label_operations (tenant_id, seller_account_id, shipment_id, operation_kind, target_key)
  WHERE status IN ('reserved', 'invoking', 'ambiguous', 'provider-succeeded', 'effect-applied');`;

const fulfillmentPostageLabelOperationsDropSupersededActiveKindIndexSql = `DROP INDEX CONCURRENTLY IF EXISTS fulfillment_postage_label_operations_active_kind_idx;`;

const fulfillmentShipmentMutationAuthorityColumnsSql = `SET LOCAL lock_timeout = '5s';

ALTER TABLE fulfillment_shipment_pages
  ADD COLUMN IF NOT EXISTS tenant_id text NULL;

ALTER TABLE fulfillment_postage_label_operations
  ADD COLUMN IF NOT EXISTS operation_id text NULL,
  ADD COLUMN IF NOT EXISTS tenant_id text NULL,
  ADD COLUMN IF NOT EXISTS seller_account_id text NULL,
  ADD COLUMN IF NOT EXISTS key_digest text NULL,
  ADD COLUMN IF NOT EXISTS request_hash text NULL,
  ADD COLUMN IF NOT EXISTS target_key text NULL,
  ADD COLUMN IF NOT EXISTS provider_idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS provider_result_json jsonb NULL,
  ADD COLUMN IF NOT EXISTS lifecycle_generation integer NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_token text NULL,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS closed_reason text NULL,
  ADD COLUMN IF NOT EXISTS provider_invoked boolean NULL DEFAULT false;`;

const fulfillmentShipmentMutationAuthorityBackfillSql = `SET LOCAL lock_timeout = '5s';

ALTER TABLE fulfillment_postage_label_operations
  DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_lifecycle_present;

ALTER TABLE fulfillment_postage_label_operations
  ADD CONSTRAINT fulfillment_postage_label_operations_lifecycle_present
  CHECK (lifecycle_generation IS NOT NULL AND provider_invoked IS NOT NULL) NOT VALID;

ALTER TABLE fulfillment_postage_label_operations
  VALIDATE CONSTRAINT fulfillment_postage_label_operations_lifecycle_present;

UPDATE fulfillment_postage_label_operations
SET operation_id = 'pop_' || md5('fulfillment-postage-operation-locator/v1:' || operation_key)
WHERE operation_id IS NULL;

ALTER TABLE fulfillment_postage_label_operations
  DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_operation_id_present;

ALTER TABLE fulfillment_postage_label_operations
  ADD CONSTRAINT fulfillment_postage_label_operations_operation_id_present
  CHECK (operation_id IS NOT NULL) NOT VALID;

ALTER TABLE fulfillment_postage_label_operations
  VALIDATE CONSTRAINT fulfillment_postage_label_operations_operation_id_present;

UPDATE fulfillment_postage_label_operations
SET status = CASE status
  WHEN 'pending' THEN 'reserved'
  WHEN 'succeeded' THEN 'effect-applied'
  WHEN 'failed' THEN 'ambiguous'
  ELSE status
END;

CREATE TABLE IF NOT EXISTS fulfillment_shipment_tenant_resolutions (
  shipment_id text PRIMARY KEY,
  tenant_id text NULL,
  seller_account_id text NULL,
  status text NOT NULL CHECK (status IN ('resolved', 'quarantined')),
  reason_code text NOT NULL,
  resolved_at timestamptz NOT NULL
);

WITH authority AS (
  SELECT
    page.shipment_id,
    MIN(NULLIF(events.tenant_id, '')) AS tenant_id,
    COUNT(DISTINCT NULLIF(events.tenant_id, '')) AS tenant_count,
    COUNT(events.event_id) FILTER (
      WHERE events.event_id IS NOT NULL AND (events.tenant_id IS NULL OR events.tenant_id = '')
    ) AS empty_tenant_count,
    MIN(events.payload->>'sellerAccountId') FILTER (WHERE events.event_type = 'fulfillment.shipment.created') AS event_seller,
    page.seller_account_id AS page_seller
  FROM fulfillment_shipment_pages AS page
  LEFT JOIN event_store_events AS events
    ON events.stream_id = 'fulfillment.shipment-' || page.shipment_id
  GROUP BY page.shipment_id, page.seller_account_id
), resolution AS (
  SELECT
    shipment_id,
    CASE WHEN tenant_count = 1 AND empty_tenant_count = 0 AND event_seller = page_seller THEN tenant_id ELSE NULL END AS tenant_id,
    CASE WHEN tenant_count = 1 AND empty_tenant_count = 0 AND event_seller = page_seller THEN page_seller ELSE NULL END AS seller_account_id,
    CASE WHEN tenant_count = 1 AND empty_tenant_count = 0 AND event_seller = page_seller THEN 'resolved' ELSE 'quarantined' END AS status,
    CASE
      WHEN tenant_count = 0 THEN 'shipment-history-absent'
      WHEN empty_tenant_count > 0 THEN 'shipment-history-empty-tenant'
      WHEN tenant_count <> 1 THEN 'shipment-history-mixed-tenant'
      WHEN event_seller IS DISTINCT FROM page_seller THEN 'shipment-seller-mismatch'
      ELSE 'authoritative-history'
    END AS reason_code
  FROM authority
)
INSERT INTO fulfillment_shipment_tenant_resolutions (
  shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at
)
SELECT shipment_id, tenant_id, seller_account_id, status, reason_code, now()
FROM resolution
ON CONFLICT (shipment_id) DO UPDATE
SET tenant_id = EXCLUDED.tenant_id,
    seller_account_id = EXCLUDED.seller_account_id,
    status = EXCLUDED.status,
    reason_code = EXCLUDED.reason_code,
    resolved_at = EXCLUDED.resolved_at;

UPDATE fulfillment_shipment_pages AS page
SET tenant_id = resolution.tenant_id
FROM fulfillment_shipment_tenant_resolutions AS resolution
WHERE resolution.shipment_id = page.shipment_id
  AND resolution.status = 'resolved';

UPDATE fulfillment_postage_label_operations AS operation
SET tenant_id = resolution.tenant_id,
    seller_account_id = resolution.seller_account_id,
    target_key = COALESCE(
      operation.target_key,
      operation.shipment_id || ':' || operation.operation_kind || ':retained:' || operation.operation_key
    ),
    key_digest = COALESCE(operation.key_digest, operation.operation_key),
    request_hash = COALESCE(operation.request_hash, md5(operation.request_json::text)),
    provider_idempotency_key = COALESCE(operation.provider_idempotency_key, operation.idempotency_key)
FROM fulfillment_shipment_tenant_resolutions AS resolution
WHERE resolution.shipment_id = operation.shipment_id
  AND resolution.status = 'resolved';

`;

const fulfillmentShipmentOperationIdIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_postage_label_operations_operation_id_idx
  ON fulfillment_postage_label_operations (operation_id);`;

const fulfillmentShipmentOperationReceiptIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_postage_label_operations_receipt_idx
  ON fulfillment_postage_label_operations (tenant_id, seller_account_id, key_digest)
  WHERE tenant_id IS NOT NULL AND seller_account_id IS NOT NULL AND key_digest IS NOT NULL;`;

const fulfillmentShipmentWebhookAuthorityColumnsSql = `ALTER TABLE fulfillment_postage_provider_events
  ADD COLUMN IF NOT EXISTS payload_hash text NULL,
  ADD COLUMN IF NOT EXISTS handoff_state text NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS receipt_version integer NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS claim_token text NULL,
  ADD COLUMN IF NOT EXISTS claim_generation integer NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz NULL;`;

const fulfillmentShipmentWebhookAuthorityConstraintsSql = `SET LOCAL lock_timeout = '5s';

ALTER TABLE fulfillment_postage_provider_events
  DROP CONSTRAINT IF EXISTS fulfillment_postage_provider_events_handoff_present;

ALTER TABLE fulfillment_postage_provider_events
  ADD CONSTRAINT fulfillment_postage_provider_events_handoff_present
  CHECK (handoff_state IS NOT NULL AND receipt_version IS NOT NULL AND claim_generation IS NOT NULL) NOT VALID;

ALTER TABLE fulfillment_postage_provider_events
  VALIDATE CONSTRAINT fulfillment_postage_provider_events_handoff_present;
`;

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
  tenant_id text NULL,
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
  operation_id text NOT NULL UNIQUE,
  operation_kind text NOT NULL CHECK (operation_kind IN ('purchase-usps-label', 'void-label', 'orphan-label-void')),
  shipment_id text NOT NULL,
  tenant_id text NULL,
  seller_account_id text NULL,
  key_digest text NULL,
  request_hash text NULL,
  target_key text NULL,
  provider_name text NOT NULL,
  provider_mode text NOT NULL,
  idempotency_key text NOT NULL,
  provider_idempotency_key text NULL,
  provider_result_json jsonb NULL,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('reserved', 'invoking', 'ambiguous', 'provider-succeeded', 'effect-applied', 'failed-safe')),
  lifecycle_generation integer NOT NULL DEFAULT 0,
  claim_token text NULL,
  claim_expires_at timestamptz NULL,
  closed_reason text NULL,
  provider_invoked boolean NOT NULL DEFAULT false,
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

CREATE TABLE IF NOT EXISTS fulfillment_shipment_tenant_resolutions (
  shipment_id text PRIMARY KEY,
  tenant_id text NULL,
  seller_account_id text NULL,
  status text NOT NULL CHECK (status IN ('resolved', 'quarantined')),
  reason_code text NOT NULL,
  resolved_at timestamptz NOT NULL
);

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
  ,payload_hash text NULL
  ,handoff_state text NOT NULL DEFAULT 'completed'
  ,receipt_version integer NOT NULL DEFAULT 1
  ,claim_token text NULL
  ,claim_generation integer NOT NULL DEFAULT 0
  ,claim_expires_at timestamptz NULL
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
      fulfillmentPostageLabelOperationsLegacyStatusConstraintSql,
      fulfillmentPostageLabelOperationsDuplicateActiveBackfillSql,
      fulfillmentPostageLabelOperationsLegacyActiveKindIndexSql,
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
  {
    migrationId: "20260823_fulfillment_shipment_mutation_authority_v1",
    description: "Bind Shipment and postage mutation receipts to tenant authority and install fenced lifecycles.",
    statements: [
      fulfillmentShipmentMutationAuthorityColumnsSql,
      fulfillmentPostageLabelOperationsDropLegacyConstraintsSql,
      fulfillmentShipmentMutationAuthorityBackfillSql,
      fulfillmentShipmentOperationIdIndexSql,
      fulfillmentShipmentOperationReceiptIndexSql,
      fulfillmentShipmentWebhookAuthorityColumnsSql,
      fulfillmentShipmentWebhookAuthorityConstraintsSql,
      fulfillmentPostageLabelOperationsStatusConstraintSql,
      fulfillmentPostageLabelOperationsOperationKindConstraintSql,
      `SET lock_timeout = '5s'`,
      fulfillmentPostageLabelOperationsDropSupersededActiveKindIndexSql,
      fulfillmentPostageLabelOperationsActiveTargetIndexV1Sql,
    ],
  },
];
