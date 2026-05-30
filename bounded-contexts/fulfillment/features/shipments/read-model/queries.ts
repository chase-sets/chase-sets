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
) {
  const timestamp = operation.createdAt ?? new Date().toISOString();
  await db.query(
    `INSERT INTO fulfillment_postage_label_operations (
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
         updated_at = EXCLUDED.updated_at`,
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
     WHERE operation_key = $1`,
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
       AND status = 'pending'`,
    [operation.operationKey, operation.errorMessage, timestamp],
  );
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

  const [linesResult, exceptionsResult, addressOverrideAuditsResult] = await Promise.all([
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
  ]);

  return {
    ...row,
    shipping_origin_snapshot: null,
    lines: linesResult.rows,
    exceptions: exceptionsResult.rows,
    address_override_audits: addressOverrideAuditsResult.rows,
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

  const [linesResult, exceptionsResult, addressOverrideAuditsResult] = await Promise.all([
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
  ]);

  return {
    ...row,
    lines: linesResult.rows,
    exceptions: exceptionsResult.rows,
    address_override_audits: addressOverrideAuditsResult.rows,
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
