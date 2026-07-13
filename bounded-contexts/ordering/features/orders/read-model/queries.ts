import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { VersionSelectedOptionEntry } from "../domain/common";

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
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  marketplace_sales_fee_cap_amount: string | null;
  marketplace_sales_fee_unit_amount: string;
  marketplace_sales_fee_total_amount: string;
  seller_net_unit_amount: string;
  seller_net_total_amount: string;
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
  display_reference: string;
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
  shipping_allowance_amount: string;
  shipping_overage_amount: string;
  protection_amount: string;
  protection_allowance_amount: string;
  protection_overage_amount: string;
  shipping_charge_amount: string;
  sales_tax_amount: string;
  taxable_amount: string;
  tax_jurisdiction_country: string;
  tax_jurisdiction_state: string | null;
  tax_rate_bps: number;
  tax_provider_name: string;
  tax_provider_quote_reference: string | null;
  tax_quoted_at: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  seller_net_amount: string;
  seller_item_net_amount: string;
  seller_payout_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot;
  status: string;
  pending_payment_at: string | null;
  payment_deadline_at: string | null;
  payment_deadline_policy: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  ready_for_fulfillment_at: string | null;
  self_service_cancellation_available: boolean;
  cancellation_unavailable_reason: "payment-pending" | "fulfillment-started" | "already-cancelled" | null;
  line_count: number;
  total_quantity: number;
  item_titles: readonly string[];
}>;

export type OrderingOrderDetailRow = OrderingOrderListRow &
  Readonly<{
    lines: readonly OrderingOrderLineRow[];
    inventory_holds: readonly OrderingOrderHoldRow[];
  }>;

type BaseOrderPageRow = Readonly<{
  order_id: string;
  display_reference: string;
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
  shipping_allowance_amount: string;
  shipping_overage_amount: string;
  protection_amount: string;
  protection_allowance_amount: string;
  protection_overage_amount: string;
  shipping_charge_amount: string;
  sales_tax_amount: string;
  taxable_amount: string;
  tax_jurisdiction_country: string;
  tax_jurisdiction_state: string | null;
  tax_rate_bps: number;
  tax_provider_name: string;
  tax_provider_quote_reference: string | null;
  tax_quoted_at: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  seller_net_amount: string;
  seller_item_net_amount: string;
  seller_payout_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot;
  status: string;
  pending_payment_at: string | null;
  payment_deadline_at: string | null;
  payment_deadline_policy: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  ready_for_fulfillment_at: string | null;
  self_service_cancellation_available: boolean;
  cancellation_unavailable_reason: "payment-pending" | "fulfillment-started" | "already-cancelled" | null;
  line_count: number;
  total_quantity: number;
  item_titles: readonly string[];
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
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  marketplace_sales_fee_cap_amount: string | null;
  marketplace_sales_fee_unit_amount: string;
  marketplace_sales_fee_total_amount: string;
  seller_net_unit_amount: string;
  seller_net_total_amount: string;
}>;

const baseOrderSelect = `
  SELECT
    page.order_id,
    page.display_reference,
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
    page.shipping_allowance_amount::text AS shipping_allowance_amount,
    page.shipping_overage_amount::text AS shipping_overage_amount,
    page.protection_amount::text AS protection_amount,
    page.protection_allowance_amount::text AS protection_allowance_amount,
    page.protection_overage_amount::text AS protection_overage_amount,
    page.shipping_charge_amount::text AS shipping_charge_amount,
    page.sales_tax_amount::text AS sales_tax_amount,
    page.taxable_amount::text AS taxable_amount,
    page.tax_jurisdiction_country,
    page.tax_jurisdiction_state,
    page.tax_rate_bps,
    page.tax_provider_name,
    page.tax_provider_quote_reference,
    page.tax_quoted_at,
    page.total_amount::text AS total_amount,
    page.marketplace_sales_fee_amount::text AS marketplace_sales_fee_amount,
    page.seller_net_amount::text AS seller_net_amount,
    page.seller_item_net_amount::text AS seller_item_net_amount,
    page.seller_payout_amount::text AS seller_payout_amount,
    page.shipping_allowance_percentage_bps,
    page.terms_schedule_id,
    page.terms_agreement_id,
    page.terms_resolved_at,
    page.shipping_destination_snapshot,
    page.shipping_origin_snapshot,
    page.status,
    page.pending_payment_at,
    COALESCE(payment_deadline.payment_deadline_at, page.payment_deadline_at) AS payment_deadline_at,
    COALESCE(payment_deadline.payment_deadline_policy, page.payment_deadline_policy) AS payment_deadline_policy,
    page.created_at,
    page.updated_at,
    page.cancelled_at,
    page.cancellation_reason,
    page.ready_for_fulfillment_at,
    CASE
      WHEN page.status IN ('pending-payment', 'pending-reservation') THEN true
      WHEN page.status = 'ready-for-fulfillment'
        AND fulfillment.shipment_status = 'awaiting-package'
        AND fulfillment.package_status = 'awaiting-package'
        AND fulfillment.package_prepared_at IS NULL
        AND fulfillment.cancelled_at IS NULL
      THEN true
      ELSE false
    END AS self_service_cancellation_available,
    CASE
      WHEN page.status = 'cancelled' THEN 'already-cancelled'
      WHEN page.status IN ('pending-payment', 'pending-reservation') THEN NULL
      WHEN page.status = 'ready-for-fulfillment'
        AND fulfillment.shipment_status = 'awaiting-package'
        AND fulfillment.package_status = 'awaiting-package'
        AND fulfillment.package_prepared_at IS NULL
        AND fulfillment.cancelled_at IS NULL
      THEN NULL
      WHEN page.status = 'ready-for-fulfillment' THEN 'fulfillment-started'
      ELSE 'payment-pending'
    END AS cancellation_unavailable_reason,
    COALESCE(line_stats.line_count, 0) AS line_count,
    COALESCE(line_stats.total_quantity, 0) AS total_quantity,
    COALESCE(line_stats.item_titles, ARRAY[]::text[]) AS item_titles
  FROM ordering_order_pages AS page
  LEFT JOIN ordering_account_pages AS buyer
    ON buyer.account_id = page.buyer_account_id
  LEFT JOIN ordering_account_pages AS seller
    ON seller.account_id = page.seller_account_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::integer AS line_count,
      COALESCE(SUM(quantity), 0)::integer AS total_quantity,
      COALESCE(array_agg(item_title ORDER BY line_index ASC), ARRAY[]::text[]) AS item_titles
    FROM ordering_order_line_pages AS line
    WHERE line.order_id = page.order_id
  ) AS line_stats
    ON true
  LEFT JOIN ordering_fulfillment_cancellation_inputs AS fulfillment
    ON fulfillment.order_id = page.order_id
  LEFT JOIN ordering_payment_deadline_inputs AS payment_deadline
    ON payment_deadline.order_id = page.order_id
`;

function mapOrderLine(row: OrderLinePageRow): OrderingOrderLineRow {
  return {
    ...row,
    selected_options: Array.isArray(row.selected_options) ? (row.selected_options as VersionSelectedOptionEntry[]) : [],
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

async function summarizeOrderList(
  db: PgQueryable,
  column: "buyer_account_id" | "seller_account_id",
  accountId: string,
): Promise<{ total_quantity: number; pending_count: number }> {
  const result = await db.query<{ total_quantity: string; pending_count: string }>(
    `SELECT
       COALESCE(
         (SELECT SUM(line.quantity)
          FROM ordering_order_line_pages AS line
          JOIN ordering_order_pages AS page ON page.order_id = line.order_id
          WHERE page.${column} = $1),
         0
       ) AS total_quantity,
       COUNT(*) FILTER (WHERE status LIKE 'pending%') AS pending_count
     FROM ordering_order_pages
     WHERE ${column} = $1`,
    [accountId],
  );
  const row = result.rows[0];

  return {
    total_quantity: Number(row?.total_quantity ?? 0),
    pending_count: Number(row?.pending_count ?? 0),
  };
}

export async function getPurchaseListSummary(db: PgQueryable, buyerAccountId: string) {
  return summarizeOrderList(db, "buyer_account_id", buyerAccountId);
}

export async function getSaleListSummary(db: PgQueryable, sellerAccountId: string) {
  return summarizeOrderList(db, "seller_account_id", sellerAccountId);
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
         line_total_amount::text AS line_total_amount,
         marketplace_sales_fee_percentage_bps,
         marketplace_sales_fee_fixed_amount::text AS marketplace_sales_fee_fixed_amount,
         marketplace_sales_fee_cap_amount::text AS marketplace_sales_fee_cap_amount,
         marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
         marketplace_sales_fee_total_amount::text AS marketplace_sales_fee_total_amount,
         seller_net_unit_amount::text AS seller_net_unit_amount,
         seller_net_total_amount::text AS seller_net_total_amount
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
         line_total_amount::text AS line_total_amount,
         marketplace_sales_fee_percentage_bps,
         marketplace_sales_fee_fixed_amount::text AS marketplace_sales_fee_fixed_amount,
         marketplace_sales_fee_cap_amount::text AS marketplace_sales_fee_cap_amount,
         marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
         marketplace_sales_fee_total_amount::text AS marketplace_sales_fee_total_amount,
         seller_net_unit_amount::text AS seller_net_unit_amount,
         seller_net_total_amount::text AS seller_net_total_amount
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
  sourceType: "cart-checkout" | "offer-acceptance" | "buy-now",
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

export async function listOrderIdsForSource(
  db: PgQueryable,
  sourceType: "cart-checkout" | "offer-acceptance" | "buy-now",
  sourceReferenceId: string,
): Promise<string[]> {
  const result = await db.query<{ order_id: string }>(
    `SELECT order_id
     FROM ordering_order_pages
     WHERE source_type = $1
       AND source_reference_id = $2
     ORDER BY order_id ASC`,
    [sourceType, sourceReferenceId],
  );

  return result.rows.map((row) => row.order_id);
}

export async function resolveOrderRecipient(db: PgQueryable, orderId: string): Promise<string | null> {
  const result = await db.query<{ buyer_account_id: string }>(
    `SELECT buyer_account_id
     FROM ordering_order_pages
     WHERE order_id = $1
     LIMIT 1`,
    [orderId],
  );

  return result.rows[0]?.buyer_account_id ?? null;
}

export async function resolveShipmentOrderId(db: PgQueryable, shipmentId: string): Promise<string | null> {
  const result = await db.query<{ order_id: string }>(
    `SELECT order_id
     FROM ordering_fulfillment_cancellation_inputs
     WHERE shipment_id = $1
     LIMIT 1`,
    [shipmentId],
  );

  return result.rows[0]?.order_id ?? null;
}

export type PaymentDeadlineCancellationCandidate = Readonly<{
  order_id: string;
  payment_deadline_at: string;
  payment_deadline_policy: string;
}>;

export async function listPendingPaymentOrdersPastDeadline(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly PaymentDeadlineCancellationCandidate[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<PaymentDeadlineCancellationCandidate>(
    `SELECT
       page.order_id,
       COALESCE(payment_deadline.payment_deadline_at, page.payment_deadline_at)::text AS payment_deadline_at,
       COALESCE(payment_deadline.payment_deadline_policy, page.payment_deadline_policy) AS payment_deadline_policy
     FROM ordering_order_pages AS page
     LEFT JOIN ordering_payment_deadline_inputs AS payment_deadline
       ON payment_deadline.order_id = page.order_id
     WHERE page.status = 'pending-payment'
       AND COALESCE(payment_deadline.payment_deadline_at, page.payment_deadline_at) IS NOT NULL
       AND COALESCE(payment_deadline.payment_deadline_at, page.payment_deadline_at) <= $1::timestamptz
     ORDER BY COALESCE(payment_deadline.payment_deadline_at, page.payment_deadline_at), page.order_id
     LIMIT $2`,
    [params.now, limit],
  );

  return result.rows;
}
