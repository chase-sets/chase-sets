import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export type OrderingOrderLineRow = Readonly<{
  line_id: string;
  listing_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  unit_price_amount: string;
  quantity: number;
  line_total_amount: string;
}>;

export type OrderingOrderHoldRow = Readonly<{
  hold_id: string;
  inventory_item_id: string;
  seller_account_id: string;
  quantity: number;
  status: string;
  created_at: string;
  released_at: string | null;
}>;

export type OrderingOrderListRow = Readonly<{
  order_id: string;
  source_type: string;
  source_reference_id: string | null;
  buyer_account_id: string;
  buyer_display_name: string | null;
  seller_account_id: string;
  seller_display_name: string | null;
  shipping_option: string;
  item_subtotal_amount: string;
  shipping_base_amount: string;
  shipping_discount_amount: string;
  shipping_charge_amount: string;
  total_amount: string;
  marketplace_fee_amount: string;
  payment_fee_amount: string;
  seller_net_amount: string;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  ready_for_fulfillment_at: string | null;
  line_count: number;
  total_quantity: number;
}>;

export type OrderingOrderDetailRow = OrderingOrderListRow &
  Readonly<{
    lines: readonly OrderingOrderLineRow[];
    inventory_holds: readonly OrderingOrderHoldRow[];
  }>;

type BaseOrderPageRow = Readonly<{
  order_id: string;
  source_type: string;
  source_reference_id: string | null;
  buyer_account_id: string;
  buyer_display_name: string | null;
  seller_account_id: string;
  seller_display_name: string | null;
  shipping_option: string;
  item_subtotal_amount: string;
  shipping_base_amount: string;
  shipping_discount_amount: string;
  shipping_charge_amount: string;
  total_amount: string;
  marketplace_fee_amount: string;
  payment_fee_amount: string;
  seller_net_amount: string;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  ready_for_fulfillment_at: string | null;
  line_count: number;
  total_quantity: number;
}>;

type OrderLinePageRow = Readonly<{
  line_id: string;
  listing_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  unit_price_amount: string;
  quantity: number;
  line_total_amount: string;
}>;

const baseOrderSelect = `
  SELECT
    page.order_id,
    page.source_type,
    page.source_reference_id,
    page.buyer_account_id,
    buyer.display_name AS buyer_display_name,
    page.seller_account_id,
    seller.display_name AS seller_display_name,
    page.shipping_option,
    page.item_subtotal_amount::text AS item_subtotal_amount,
    page.shipping_base_amount::text AS shipping_base_amount,
    page.shipping_discount_amount::text AS shipping_discount_amount,
    page.shipping_charge_amount::text AS shipping_charge_amount,
    page.total_amount::text AS total_amount,
    page.marketplace_fee_amount::text AS marketplace_fee_amount,
    page.payment_fee_amount::text AS payment_fee_amount,
    page.seller_net_amount::text AS seller_net_amount,
    page.terms_schedule_id,
    page.terms_agreement_id,
    page.terms_resolved_at,
    page.status,
    page.created_at,
    page.updated_at,
    page.cancelled_at,
    page.cancellation_reason,
    page.ready_for_fulfillment_at,
    COALESCE(line_stats.line_count, 0) AS line_count,
    COALESCE(line_stats.total_quantity, 0) AS total_quantity
  FROM ordering_order_pages AS page
  LEFT JOIN ordering_account_pages AS buyer
    ON buyer.account_id = page.buyer_account_id
  LEFT JOIN ordering_account_pages AS seller
    ON seller.account_id = page.seller_account_id
  LEFT JOIN (
    SELECT
      order_id,
      COUNT(*)::integer AS line_count,
      COALESCE(SUM(quantity), 0)::integer AS total_quantity
    FROM ordering_order_line_pages
    GROUP BY order_id
  ) AS line_stats
    ON line_stats.order_id = page.order_id
`;

function mapOrderLine(row: OrderLinePageRow): OrderingOrderLineRow {
  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as VersionSelectedOptionEntry[])
      : [],
  };
}

export async function listPurchases(
  db: PgQueryable,
  params: Readonly<{ buyerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: OrderingOrderListRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM ordering_order_pages
       WHERE buyer_account_id = $1`,
      [params.buyerAccountId],
    ),
    db.query<BaseOrderPageRow>(
      `${baseOrderSelect}
       WHERE page.buyer_account_id = $1
       ORDER BY page.updated_at DESC, page.order_id DESC
       LIMIT $2 OFFSET $3`,
      [params.buyerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getPurchase(
  db: PgQueryable,
  orderId: string,
  buyerAccountId: string,
): Promise<OrderingOrderDetailRow | null> {
  const result = await db.query<BaseOrderPageRow>(
    `${baseOrderSelect}
     WHERE page.order_id = $1
       AND page.buyer_account_id = $2`,
    [orderId, buyerAccountId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const [linesResult, holdsResult] = await Promise.all([
    db.query<OrderLinePageRow>(
      `SELECT
         line_id,
         listing_id,
         inventory_item_id,
         catalog_catalog_item_id,
         product_id,
         item_title,
         item_subtitle,
         selected_options,
         product_summary,
         unit_price_amount::text AS unit_price_amount,
         quantity,
         line_total_amount::text AS line_total_amount
       FROM ordering_order_line_pages
       WHERE order_id = $1
       ORDER BY line_index ASC, line_id ASC`,
      [orderId],
    ),
    db.query<OrderingOrderHoldRow>(
      `SELECT
         hold_id,
         inventory_item_id,
         seller_account_id,
         quantity,
         status,
         created_at,
         released_at
       FROM ordering_order_hold_pages
       WHERE order_id = $1
       ORDER BY created_at ASC, hold_id ASC`,
      [orderId],
    ),
  ]);

  return {
    ...row,
    lines: linesResult.rows.map(mapOrderLine),
    inventory_holds: holdsResult.rows,
  };
}

export async function listSales(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: OrderingOrderListRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM ordering_order_pages
       WHERE seller_account_id = $1`,
      [params.sellerAccountId],
    ),
    db.query<BaseOrderPageRow>(
      `${baseOrderSelect}
       WHERE page.seller_account_id = $1
       ORDER BY page.updated_at DESC, page.order_id DESC
       LIMIT $2 OFFSET $3`,
      [params.sellerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getSale(
  db: PgQueryable,
  orderId: string,
  sellerAccountId: string,
): Promise<OrderingOrderDetailRow | null> {
  const result = await db.query<BaseOrderPageRow>(
    `${baseOrderSelect}
     WHERE page.order_id = $1
       AND page.seller_account_id = $2`,
    [orderId, sellerAccountId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const [linesResult, holdsResult] = await Promise.all([
    db.query<OrderLinePageRow>(
      `SELECT
         line_id,
         listing_id,
         inventory_item_id,
         catalog_catalog_item_id,
         product_id,
         item_title,
         item_subtitle,
         selected_options,
         product_summary,
         unit_price_amount::text AS unit_price_amount,
         quantity,
         line_total_amount::text AS line_total_amount
       FROM ordering_order_line_pages
       WHERE order_id = $1
       ORDER BY line_index ASC, line_id ASC`,
      [orderId],
    ),
    db.query<OrderingOrderHoldRow>(
      `SELECT
         hold_id,
         inventory_item_id,
         seller_account_id,
         quantity,
         status,
         created_at,
         released_at
       FROM ordering_order_hold_pages
       WHERE order_id = $1
       ORDER BY created_at ASC, hold_id ASC`,
      [orderId],
    ),
  ]);

  return {
    ...row,
    lines: linesResult.rows.map(mapOrderLine),
    inventory_holds: holdsResult.rows,
  };
}

export async function hasOrderForSource(
  db: PgQueryable,
  sourceType: "cart-checkout" | "offer-acceptance",
  sourceReferenceId: string,
): Promise<boolean> {
  const result = await db.query<{ order_id: string }>(
    `SELECT order_id
     FROM ordering_order_pages
     WHERE source_type = $1
       AND source_reference_id = $2
     LIMIT 1`,
    [sourceType, sourceReferenceId],
  );

  return Boolean(result.rows[0]?.order_id);
}
