import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { PackagePlan } from "@chase-sets/product-measures";

export type FulfillmentShipmentLineRow = Readonly<{
  line_id: string;
  order_line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  product_summary: string | null;
  quantity: number;
  packing_confirmed_quantity: number;
  packing_confirmed_at: string | null;
}>;

export type FulfillmentShipmentExceptionRow = Readonly<{
  raised_at: string;
  exception_type: string;
  notes: string | null;
}>;

export type FulfillmentLabelAddressOverrideAuditRow = Readonly<{
  recorded_at: string;
  changed_side: string;
  reason: string;
  actor: string;
  original_sender_snapshot: AddressSnapshot;
  submitted_sender_address: AddressSnapshot;
  original_recipient_snapshot: AddressSnapshot;
  submitted_recipient_address: AddressSnapshot;
}>;

export type FulfillmentPostageLabelOperationDiagnosticRow = Readonly<{
  operation_key: string;
  operation_kind: string;
  provider_name: string;
  provider_mode: string;
  status: string;
  requested_service_level: string | null;
  requested_delivery_confirmation: string | null;
  requested_insurance_amount: string | null;
  requested_label_size: string | null;
  requested_mailpiece_class: string | null;
  requested_weight_ounces: string | null;
  address_override_changed_side: string | null;
  address_override_reason: string | null;
  policy_version: string | null;
  parcel_required: string | null;
  signature_required: string | null;
  insurance_required: string | null;
  insured_value_amount: string | null;
  shipping_evidence_tier: string | null;
  provider_shipment_id: string | null;
  provider_label_id: string | null;
  tracking_identifier: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

export type FulfillmentPostageLabelOperationRecord = Readonly<{
  operation_key: string;
  operation_kind: "purchase-usps-label" | "void-label";
  shipment_id: string;
  provider_name: string;
  provider_mode: string;
  idempotency_key: string;
  request_json: unknown;
  status: "pending" | "provider-succeeded" | "succeeded" | "failed";
  provider_shipment_id: string | null;
  provider_label_id: string | null;
  tracking_identifier: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

export type FulfillmentPostageLabelOperationReservation = FulfillmentPostageLabelOperationRecord &
  Readonly<{
    operation_reserved: boolean;
  }>;

export type FulfillmentPostageProviderEventDiagnosticRow = Readonly<{
  provider_event_id: string;
  provider_name: string;
  provider_mode: string;
  event_kind: string;
  provider_object_reference: string | null;
  tracking_identifier: string | null;
  status: string;
  status_detail: string | null;
  processing_result: string | null;
  occurred_at: string;
  received_at: string;
}>;

export type FulfillmentShipmentListRow = Readonly<{
  shipment_id: string;
  order_id: string;
  buyer_account_id: string;
  buyer_display_name: string | null;
  seller_account_id: string;
  seller_display_name: string | null;
  shipping_option: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot | null;
  shipping_plan_snapshot: PackagePlan | null;
  shipping_method: string | null;
  carrier_name: string | null;
  display_reference: string;
  label_reference: string | null;
  label_document_url: string | null;
  tracking_identifier: string | null;
  postage_provider_name: string | null;
  postage_provider_mode: string | null;
  postage_provider_shipment_id: string | null;
  postage_provider_label_id: string | null;
  postage_rate_id: string | null;
  postage_service_level: string | null;
  postage_amount_cents: number | null;
  postage_currency: string | null;
  label_status: string;
  label_error_code: string | null;
  label_error_message: string | null;
  label_refund_status: string | null;
  label_refund_reference: string | null;
  status: string;
  package_status: string;
  package_count: number | null;
  current_exception_type: string | null;
  current_exception_notes: string | null;
  created_at: string;
  updated_at: string;
  packing_started_at: string | null;
  package_prepared_at: string | null;
  label_attached_at: string | null;
  label_voided_at: string | null;
  cancelled_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  returned_at: string | null;
  exception_raised_at: string | null;
  line_count: number;
  total_quantity: number;
}>;

export type FulfillmentShipmentDetailRow = FulfillmentShipmentListRow &
  Readonly<{
    lines: readonly FulfillmentShipmentLineRow[];
    exceptions: readonly FulfillmentShipmentExceptionRow[];
    address_override_audits: readonly FulfillmentLabelAddressOverrideAuditRow[];
    postage_label_operations: readonly FulfillmentPostageLabelOperationDiagnosticRow[];
    postage_provider_events: readonly FulfillmentPostageProviderEventDiagnosticRow[];
  }>;

export async function recordFulfillmentPostageLabelOperationPending(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    operationKind: "purchase-usps-label" | "void-label";
    shipmentId: string;
    providerName: string;
    providerMode: string;
    idempotencyKey: string;
    request?: unknown;
    createdAt?: string;
  }>,
): Promise<FulfillmentPostageLabelOperationReservation> {
  const timestamp = operation.createdAt ?? new Date().toISOString();
  const result = await db.query<FulfillmentPostageLabelOperationReservation>(
    `WITH reserved_operation AS (
       INSERT INTO fulfillment_postage_label_operations (
         operation_key,
         operation_kind,
         shipment_id,
         provider_name,
         provider_mode,
         idempotency_key,
         request_json,
         status,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, $8)
       ON CONFLICT (operation_key) DO UPDATE
       SET provider_name = EXCLUDED.provider_name,
           provider_mode = EXCLUDED.provider_mode,
           idempotency_key = EXCLUDED.idempotency_key,
           request_json = EXCLUDED.request_json,
           status = 'pending',
           provider_shipment_id = NULL,
           provider_label_id = NULL,
           tracking_identifier = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = EXCLUDED.updated_at
       WHERE fulfillment_postage_label_operations.status = 'failed'
       RETURNING
         operation_key,
         operation_kind,
         shipment_id,
         provider_name,
         provider_mode,
         idempotency_key,
         request_json,
         status,
         provider_shipment_id,
         provider_label_id,
         tracking_identifier,
         error_message,
         created_at,
         updated_at,
         completed_at,
         TRUE AS operation_reserved
     )
     SELECT * FROM reserved_operation
     UNION ALL
     SELECT
       existing.operation_key,
       existing.operation_kind,
       existing.shipment_id,
       existing.provider_name,
       existing.provider_mode,
       existing.idempotency_key,
       existing.request_json,
       existing.status,
       existing.provider_shipment_id,
       existing.provider_label_id,
       existing.tracking_identifier,
       existing.error_message,
       existing.created_at,
       existing.updated_at,
       existing.completed_at,
       FALSE AS operation_reserved
     FROM fulfillment_postage_label_operations AS existing
     WHERE existing.operation_key = $1
       AND NOT EXISTS (SELECT 1 FROM reserved_operation)`,
    [
      operation.operationKey,
      operation.operationKind,
      operation.shipmentId,
      operation.providerName,
      operation.providerMode,
      operation.idempotencyKey,
      JSON.stringify(operation.request ?? {}),
      timestamp,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      operation_key: operation.operationKey,
      operation_kind: operation.operationKind,
      shipment_id: operation.shipmentId,
      provider_name: operation.providerName,
      provider_mode: operation.providerMode,
      idempotency_key: operation.idempotencyKey,
      request_json: operation.request ?? {},
      status: "pending",
      provider_shipment_id: null,
      provider_label_id: null,
      tracking_identifier: null,
      error_message: null,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
      operation_reserved: true,
    };
  }
  return row;
}

export async function recordFulfillmentPostageLabelOperationProviderSucceeded(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerShipmentId?: string | null;
    providerLabelId?: string | null;
    trackingIdentifier?: string | null;
    updatedAt?: string;
  }>,
) {
  const timestamp = operation.updatedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE fulfillment_postage_label_operations
     SET status = 'provider-succeeded',
         provider_shipment_id = $2,
         provider_label_id = $3,
         tracking_identifier = $4,
         error_message = NULL,
         updated_at = $5
     WHERE operation_key = $1
       AND status IN ('pending', 'provider-succeeded', 'failed')`,
    [
      operation.operationKey,
      operation.providerShipmentId ?? null,
      operation.providerLabelId ?? null,
      operation.trackingIdentifier ?? null,
      timestamp,
    ],
  );
}

export async function recordFulfillmentPostageLabelOperationSucceeded(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerShipmentId?: string | null;
    providerLabelId?: string | null;
    trackingIdentifier?: string | null;
    completedAt?: string;
  }>,
) {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE fulfillment_postage_label_operations
     SET status = 'succeeded',
         provider_shipment_id = $2,
         provider_label_id = $3,
         tracking_identifier = $4,
         error_message = NULL,
         completed_at = $5,
         updated_at = $5
     WHERE operation_key = $1
       AND status IN ('pending', 'provider-succeeded', 'succeeded', 'failed')`,
    [
      operation.operationKey,
      operation.providerShipmentId ?? null,
      operation.providerLabelId ?? null,
      operation.trackingIdentifier ?? null,
      timestamp,
    ],
  );
}

export async function recordFulfillmentPostageLabelOperationFailed(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    errorMessage: string;
    completedAt?: string;
  }>,
) {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE fulfillment_postage_label_operations
     SET status = 'failed',
         error_message = $2,
         completed_at = $3,
         updated_at = $3
     WHERE operation_key = $1
       AND status IN ('pending', 'provider-succeeded')`,
    [operation.operationKey, operation.errorMessage, timestamp],
  );
}

export async function listStaleFulfillmentPostageLabelOperations(
  db: PgQueryable,
  params: Readonly<{ staleBefore: string; limit?: number }>,
): Promise<FulfillmentPostageLabelOperationRecord[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const result = await db.query<FulfillmentPostageLabelOperationRecord>(
    `SELECT
       operation_key,
       operation_kind,
       shipment_id,
       provider_name,
       provider_mode,
       idempotency_key,
       request_json,
       status,
       provider_shipment_id,
       provider_label_id,
       tracking_identifier,
       error_message,
       created_at,
       updated_at,
       completed_at
     FROM fulfillment_postage_label_operations
     WHERE operation_kind = 'purchase-usps-label'
       AND status IN ('pending', 'provider-succeeded')
       AND updated_at <= $1
     ORDER BY updated_at ASC, operation_key ASC
     LIMIT $2`,
    [params.staleBefore, limit],
  );
  return result.rows;
}

export async function listStaleFulfillmentPostageLabelVoidOperations(
  db: PgQueryable,
  params: Readonly<{ staleBefore: string; limit?: number }>,
): Promise<FulfillmentPostageLabelOperationRecord[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const result = await db.query<FulfillmentPostageLabelOperationRecord>(
    `SELECT
       operation_key,
       operation_kind,
       shipment_id,
       provider_name,
       provider_mode,
       idempotency_key,
       request_json,
       status,
       provider_shipment_id,
       provider_label_id,
       tracking_identifier,
       error_message,
       created_at,
       updated_at,
       completed_at
     FROM fulfillment_postage_label_operations
     WHERE operation_kind = 'void-label'
       AND status IN ('pending', 'provider-succeeded')
       AND updated_at <= $1
     ORDER BY updated_at ASC, operation_key ASC
     LIMIT $2`,
    [params.staleBefore, limit],
  );
  return result.rows;
}

type BaseShipmentPageRow = FulfillmentShipmentListRow;

const baseShipmentSelect = `
  SELECT
    page.shipment_id,
    page.order_id,
    page.buyer_account_id,
    buyer.display_name AS buyer_display_name,
    page.seller_account_id,
    seller.display_name AS seller_display_name,
    page.shipping_option,
    page.shipping_destination_snapshot,
    page.shipping_origin_snapshot,
    page.shipping_plan_snapshot,
    page.shipping_method,
    page.carrier_name,
    page.display_reference,
    page.label_reference,
    page.label_document_url,
    page.tracking_identifier,
    page.postage_provider_name,
    page.postage_provider_mode,
    page.postage_provider_shipment_id,
    page.postage_provider_label_id,
    page.postage_rate_id,
    page.postage_service_level,
    page.postage_amount_cents,
    page.postage_currency,
    page.label_status,
    page.label_error_code,
    page.label_error_message,
    page.label_refund_status,
    page.label_refund_reference,
    page.status,
    page.package_status,
    page.package_count,
    page.current_exception_type,
    page.current_exception_notes,
    page.created_at,
    page.updated_at,
    page.packing_started_at,
    page.package_prepared_at,
    page.label_attached_at,
    page.label_voided_at,
    page.cancelled_at,
    page.dispatched_at,
    page.delivered_at,
    page.returned_at,
    page.exception_raised_at,
    COALESCE(line_stats.line_count, 0) AS line_count,
    COALESCE(line_stats.total_quantity, 0) AS total_quantity
  FROM fulfillment_shipment_pages AS page
  LEFT JOIN fulfillment_account_pages AS buyer
    ON buyer.account_id = page.buyer_account_id
  LEFT JOIN fulfillment_account_pages AS seller
    ON seller.account_id = page.seller_account_id
  LEFT JOIN (
    SELECT
      shipment_id,
      COUNT(*)::integer AS line_count,
      COALESCE(SUM(quantity), 0)::integer AS total_quantity
    FROM fulfillment_shipment_line_pages
    GROUP BY shipment_id
  ) AS line_stats
    ON line_stats.shipment_id = page.shipment_id
`;

export async function listBuyerShipments(
  db: PgQueryable,
  params: Readonly<{ buyerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: FulfillmentShipmentListRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM fulfillment_shipment_pages
       WHERE buyer_account_id = $1`,
      [params.buyerAccountId],
    ),
    db.query<BaseShipmentPageRow>(
      `${baseShipmentSelect}
       WHERE page.buyer_account_id = $1
       ORDER BY page.updated_at DESC, page.shipment_id DESC
       LIMIT $2 OFFSET $3`,
      [params.buyerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map((row) => ({
      ...row,
      shipping_origin_snapshot: null,
    })),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

async function loadShipmentDetailCollections(db: PgQueryable, shipmentId: string) {
  const [
    linesResult,
    exceptionsResult,
    addressOverrideAuditsResult,
    postageLabelOperationsResult,
    postageProviderEventsResult,
  ] = await Promise.all([
    db.query<FulfillmentShipmentLineRow>(
      `SELECT
         line_id,
         order_line_id,
         catalog_catalog_item_id,
         product_id,
         item_title,
         item_subtitle,
         product_summary,
         quantity,
         packing_confirmed_quantity,
         packing_confirmed_at
       FROM fulfillment_shipment_line_pages
       WHERE shipment_id = $1
       ORDER BY line_index ASC, line_id ASC`,
      [shipmentId],
    ),
    db.query<FulfillmentShipmentExceptionRow>(
      `SELECT
         raised_at,
         exception_type,
         notes
       FROM fulfillment_shipment_exception_pages
       WHERE shipment_id = $1
       ORDER BY raised_at DESC`,
      [shipmentId],
    ),
    db.query<FulfillmentLabelAddressOverrideAuditRow>(
      `SELECT
         recorded_at,
         changed_side,
         reason,
         actor,
         original_sender_snapshot,
         submitted_sender_address,
         original_recipient_snapshot,
         submitted_recipient_address
       FROM fulfillment_label_address_override_audit_pages
       WHERE shipment_id = $1
       ORDER BY recorded_at DESC`,
      [shipmentId],
    ),
    db.query<FulfillmentPostageLabelOperationDiagnosticRow>(
      `SELECT
         operation_key,
         operation_kind,
         provider_name,
         provider_mode,
         status,
         request_json #>> '{serviceLevel}' AS requested_service_level,
         request_json #>> '{deliveryConfirmation}' AS requested_delivery_confirmation,
         request_json #>> '{insuranceAmount}' AS requested_insurance_amount,
         request_json #>> '{labelSize}' AS requested_label_size,
         request_json #>> '{package,mailpieceClass}' AS requested_mailpiece_class,
         request_json #>> '{package,weightOunces}' AS requested_weight_ounces,
         request_json #>> '{addressOverride,changedSide}' AS address_override_changed_side,
         request_json #>> '{addressOverride,reason}' AS address_override_reason,
         request_json #>> '{postagePolicySnapshot,policyVersion}' AS policy_version,
         request_json #>> '{postagePolicySnapshot,parcelRequired}' AS parcel_required,
         request_json #>> '{postagePolicySnapshot,signatureRequired}' AS signature_required,
         request_json #>> '{postagePolicySnapshot,insuranceRequired}' AS insurance_required,
         request_json #>> '{postagePolicySnapshot,insuredValueAmount}' AS insured_value_amount,
         request_json #>> '{postagePolicySnapshot,shippingEvidenceTier}' AS shipping_evidence_tier,
         provider_shipment_id,
         provider_label_id,
         tracking_identifier,
         error_message,
         created_at,
         updated_at,
         completed_at
       FROM fulfillment_postage_label_operations
       WHERE shipment_id = $1
       ORDER BY created_at DESC, operation_key DESC
       LIMIT 25`,
      [shipmentId],
    ),
    db.query<FulfillmentPostageProviderEventDiagnosticRow>(
      `SELECT
         provider_event_id,
         provider_name,
         provider_mode,
         event_kind,
         provider_object_reference,
         tracking_identifier,
         status,
         status_detail,
         processing_result,
         occurred_at,
         received_at
       FROM fulfillment_postage_provider_events
       WHERE shipment_id = $1
       ORDER BY occurred_at DESC, provider_event_id DESC
       LIMIT 25`,
      [shipmentId],
    ),
  ]);

  return {
    lines: linesResult.rows,
    exceptions: exceptionsResult.rows,
    address_override_audits: addressOverrideAuditsResult.rows,
    postage_label_operations: postageLabelOperationsResult.rows,
    postage_provider_events: postageProviderEventsResult.rows,
  };
}

export async function getBuyerShipment(
  db: PgQueryable,
  shipmentId: string,
  buyerAccountId: string,
): Promise<FulfillmentShipmentDetailRow | null> {
  const result = await db.query<BaseShipmentPageRow>(
    `${baseShipmentSelect}
     WHERE page.shipment_id = $1
       AND page.buyer_account_id = $2`,
    [shipmentId, buyerAccountId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const detailCollections = await loadShipmentDetailCollections(db, shipmentId);

  return {
    ...row,
    shipping_origin_snapshot: null,
    ...detailCollections,
  };
}

export async function listSellerShipments(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: FulfillmentShipmentListRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM fulfillment_shipment_pages
       WHERE seller_account_id = $1`,
      [params.sellerAccountId],
    ),
    db.query<BaseShipmentPageRow>(
      `${baseShipmentSelect}
       WHERE page.seller_account_id = $1
       ORDER BY page.updated_at DESC, page.shipment_id DESC
       LIMIT $2 OFFSET $3`,
      [params.sellerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getShipmentForPostageRecovery(
  db: PgQueryable,
  shipmentId: string,
): Promise<FulfillmentShipmentDetailRow | null> {
  const result = await db.query<BaseShipmentPageRow>(
    `${baseShipmentSelect}
     WHERE page.shipment_id = $1`,
    [shipmentId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const detailCollections = await loadShipmentDetailCollections(db, shipmentId);

  return {
    ...row,
    ...detailCollections,
  };
}

export async function getSellerShipment(
  db: PgQueryable,
  shipmentId: string,
  sellerAccountId: string,
): Promise<FulfillmentShipmentDetailRow | null> {
  const result = await db.query<BaseShipmentPageRow>(
    `${baseShipmentSelect}
     WHERE page.shipment_id = $1
       AND page.seller_account_id = $2`,
    [shipmentId, sellerAccountId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const detailCollections = await loadShipmentDetailCollections(db, shipmentId);

  return {
    ...row,
    ...detailCollections,
  };
}

export async function listSellerPackingSlips(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; shipmentIds: readonly string[] }>,
): Promise<FulfillmentShipmentDetailRow[]> {
  const shipments = await Promise.all(
    params.shipmentIds.map((shipmentId) => getSellerShipment(db, shipmentId, params.sellerAccountId)),
  );

  return shipments.filter((shipment): shipment is FulfillmentShipmentDetailRow => shipment !== null);
}
