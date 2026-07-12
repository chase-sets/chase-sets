import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * The Trades Tape's ops-facing query surface. Public market stats (Daily
 * Product Rollup, Market-State Snapshot) already omit `excluded` trades by
 * construction -- this is the deliberate exception: an audit view that
 * surfaces exactly which trades were excluded and why, for ops to confirm a
 * print is missing for a legitimate reason rather than a bug. Not exposed on
 * any public/buyer surface.
 */

export type MarketTradeExclusionReason = "refunded" | "cancelled" | "fraud-flagged" | "self-dealing";

export type ExcludedMarketTrade = Readonly<{
  orderId: string;
  lineId: string;
  sellerAccountId: string;
  buyerAccountId: string;
  catalogItemId: string;
  productId: string;
  unitPriceAmount: string;
  quantity: number;
  saleChannel: string;
  exclusionReason: MarketTradeExclusionReason;
  soldAt: string | null;
  updatedAt: string;
}>;

export type ListExcludedMarketTradesParams = Readonly<{
  catalogItemId?: string;
  productId?: string;
  exclusionReason?: MarketTradeExclusionReason;
  limit?: number;
}>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Ops audit query: excluded Trades Tape rows with their exclusion reason, newest first. */
export async function listExcludedMarketTrades(
  db: PgQueryable,
  params: ListExcludedMarketTradesParams = {},
): Promise<readonly ExcludedMarketTrade[]> {
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const result = await db.query<{
    order_id: string;
    line_id: string;
    seller_account_id: string;
    buyer_account_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    unit_price_amount: string;
    quantity: number;
    sale_channel: string;
    exclusion_reason: MarketTradeExclusionReason;
    sold_at: string | null;
    updated_at: string;
  }>(
    `SELECT
       order_id,
       line_id,
       seller_account_id,
       buyer_account_id,
       catalog_catalog_item_id,
       product_id,
       unit_price_amount,
       quantity,
       sale_channel,
       exclusion_reason,
       sold_at,
       updated_at
     FROM pricing_market_trades
     WHERE excluded = true
       AND ($1::text IS NULL OR catalog_catalog_item_id = $1)
       AND ($2::text IS NULL OR product_id = $2)
       AND ($3::text IS NULL OR exclusion_reason = $3)
     ORDER BY updated_at DESC, order_id, line_id
     LIMIT $4`,
    [params.catalogItemId ?? null, params.productId ?? null, params.exclusionReason ?? null, limit],
  );

  return result.rows.map((row) => ({
    orderId: row.order_id,
    lineId: row.line_id,
    sellerAccountId: row.seller_account_id,
    buyerAccountId: row.buyer_account_id,
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    unitPriceAmount: row.unit_price_amount,
    quantity: row.quantity,
    saleChannel: row.sale_channel,
    exclusionReason: row.exclusion_reason,
    soldAt: row.sold_at,
    updatedAt: row.updated_at,
  }));
}
