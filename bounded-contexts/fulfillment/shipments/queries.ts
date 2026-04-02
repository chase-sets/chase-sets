import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type FulfillmentShipmentLineRow = Readonly<{
  line_id: string;
  order_line_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string;
  item_subtitle: string | null;
  version_summary: string | null;
  quantity: number;
}>;

export type FulfillmentShipmentExceptionRow = Readonly<{
  raised_at: string;
  exception_type: string;
  notes: string | null;
}>;

export type FulfillmentShipmentListRow = Readonly<{
  shipment_id: string;
  order_id: string;
  buyer_account_id: string;
  buyer_display_name: string | null;
  seller_account_id: string;
  seller_display_name: string | null;
  shipping_option: string;
  shipping_method: string | null;
  carrier_name: string | null;
  label_reference: string | null;
  tracking_identifier: string | null;
  status: string;
  package_status: string;
  package_count: number | null;
  current_exception_type: string | null;
  current_exception_notes: string | null;
  created_at: string;
  updated_at: string;
  package_prepared_at: string | null;
  label_attached_at: string | null;
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
  }>;

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
    page.shipping_method,
    page.carrier_name,
    page.label_reference,
    page.tracking_identifier,
    page.status,
    page.package_status,
    page.package_count,
    page.current_exception_type,
    page.current_exception_notes,
    page.created_at,
    page.updated_at,
    page.package_prepared_at,
    page.label_attached_at,
    page.dispatched_at,
    page.delivered_at,
    page.returned_at,
    page.exception_raised_at,
    COALESCE(line_stats.line_count, 0) AS line_count,
    COALESCE(line_stats.total_quantity, 0) AS total_quantity
  FROM fulfillment_shipment_pages AS page
  LEFT JOIN identity_accounts AS buyer
    ON buyer.account_id = page.buyer_account_id
  LEFT JOIN identity_accounts AS seller
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
    items: itemsResult.rows,
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

  const [linesResult, exceptionsResult] = await Promise.all([
    db.query<FulfillmentShipmentLineRow>(
      `SELECT
         line_id,
         order_line_id,
         catalog_item_id,
         catalog_version_key,
         item_title,
         item_subtitle,
         version_summary,
         quantity
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
  ]);

  return {
    ...row,
    lines: linesResult.rows,
    exceptions: exceptionsResult.rows,
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

  const [linesResult, exceptionsResult] = await Promise.all([
    db.query<FulfillmentShipmentLineRow>(
      `SELECT
         line_id,
         order_line_id,
         catalog_item_id,
         catalog_version_key,
         item_title,
         item_subtitle,
         version_summary,
         quantity
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
  ]);

  return {
    ...row,
    lines: linesResult.rows,
    exceptions: exceptionsResult.rows,
  };
}
