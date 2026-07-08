import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type AccountRecommendationListItem = Readonly<{
  recommendation_id: string;
  catalog_catalog_item_id: string;
  seller_account_id: string;
  action_type: "active-listing-price-update" | "draft-listing-price-update" | "draft-listing-create";
  status: "proposed" | "applied" | "dismissed" | "failed";
  listing_id: string | null;
  inventory_item_id: string | null;
  catalog_item_title: string | null;
  catalog_item_language_code: string | null;
  catalog_item_subtitle: string | null;
  catalog_item_status: string | null;
  market_price_amount: number;
  market_currency: string;
  market_signal_type: "competition" | "offer";
  market_observed_at: string;
  current_price_amount: number | null;
  recommended_list_amount: number | null;
  recommendation_reason: string | null;
  quantity_cap: number | null;
  applied_listing_id: string | null;
  last_error: string | null;
  recommendation_published_at: string | null;
  stock_on_hand_quantity: number;
  stock_reserved_quantity: number;
  active_listing_count: number;
  lowest_listing_price_amount: number | null;
  active_offer_count: number;
  highest_offer_price_amount: number | null;
  committed_order_quantity: number;
  delivered_quantity: number;
  returned_quantity: number;
  updated_at: string;
}>;

export async function listAccountRecommendations(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
): Promise<{ items: AccountRecommendationListItem[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM pricing_recommendation_pages
       WHERE seller_account_id = $1`,
      [params.accountId],
    ),
    db.query<AccountRecommendationListItem>(
      `SELECT
         recommendation_id,
         catalog_catalog_item_id,
         seller_account_id,
         action_type,
         status,
         listing_id,
         inventory_item_id,
         catalog_item_title,
         catalog_item_language_code,
         catalog_item_subtitle,
         catalog_item_status,
         market_price_amount,
         market_currency,
         market_signal_type,
         market_observed_at,
         current_price_amount,
         recommended_list_amount,
         recommendation_reason,
         quantity_cap,
         applied_listing_id,
         last_error,
         recommendation_published_at,
         stock_on_hand_quantity,
         stock_reserved_quantity,
         active_listing_count,
         lowest_listing_price_amount,
         active_offer_count,
         highest_offer_price_amount,
         committed_order_quantity,
         delivered_quantity,
         returned_quantity,
         updated_at
       FROM pricing_recommendation_feed
       WHERE seller_account_id = $1
       ORDER BY updated_at DESC, recommendation_id DESC
       LIMIT $2 OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  return {
    items: itemResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getAccountRecommendation(
  db: PgQueryable,
  recommendationId: string,
  accountId: string,
): Promise<AccountRecommendationListItem | null> {
  const result = await db.query<AccountRecommendationListItem>(
    `SELECT
       recommendation_id,
       catalog_catalog_item_id,
       seller_account_id,
       action_type,
       status,
       listing_id,
       inventory_item_id,
       catalog_item_title,
       catalog_item_language_code,
       catalog_item_subtitle,
       catalog_item_status,
       market_price_amount,
       market_currency,
       market_signal_type,
       market_observed_at,
       current_price_amount,
       recommended_list_amount,
       recommendation_reason,
       quantity_cap,
       applied_listing_id,
       last_error,
       recommendation_published_at,
       stock_on_hand_quantity,
       stock_reserved_quantity,
       active_listing_count,
       lowest_listing_price_amount,
       active_offer_count,
       highest_offer_price_amount,
       committed_order_quantity,
       delivered_quantity,
       returned_quantity,
       updated_at
     FROM pricing_recommendation_feed
     WHERE recommendation_id = $1
       AND seller_account_id = $2`,
    [recommendationId, accountId],
  );

  return result.rows[0] ?? null;
}

export async function listAccountRecommendationsByIds(
  db: PgQueryable,
  params: Readonly<{ accountId: string; recommendationIds: readonly string[] }>,
): Promise<AccountRecommendationListItem[]> {
  if (params.recommendationIds.length === 0) {
    return [];
  }

  const result = await db.query<AccountRecommendationListItem>(
    `SELECT
       recommendation_id,
       catalog_catalog_item_id,
       seller_account_id,
       action_type,
       status,
       listing_id,
       inventory_item_id,
       catalog_item_title,
       catalog_item_language_code,
       catalog_item_subtitle,
       catalog_item_status,
       market_price_amount,
       market_currency,
       market_signal_type,
       market_observed_at,
       current_price_amount,
       recommended_list_amount,
       recommendation_reason,
       quantity_cap,
       applied_listing_id,
       last_error,
       recommendation_published_at,
       stock_on_hand_quantity,
       stock_reserved_quantity,
       active_listing_count,
       lowest_listing_price_amount,
       active_offer_count,
       highest_offer_price_amount,
       committed_order_quantity,
       delivered_quantity,
       returned_quantity,
       updated_at
     FROM pricing_recommendation_feed
     WHERE seller_account_id = $1
       AND recommendation_id = ANY($2::text[])
     ORDER BY updated_at DESC, recommendation_id DESC`,
    [params.accountId, params.recommendationIds],
  );

  return result.rows;
}

export type AccountRecommendationSignalExplanation = Readonly<{
  accountId: string;
  catalogItemId: string;
  productId: string | null;
  inventory: Readonly<{
    stockOnHandQuantity: number;
    stockReservedQuantity: number;
    availableQuantity: number;
  }>;
  market: Readonly<{
    activeListingCount: number;
    lowestListingPriceAmount: number | null;
    activeOfferCount: number;
    highestOfferPriceAmount: number | null;
  }>;
  orders: Readonly<{
    committedOrderQuantity: number;
  }>;
  fulfillment: Readonly<{
    deliveredQuantity: number;
    returnedQuantity: number;
  }>;
  recommendations: readonly AccountRecommendationListItem[];
}>;

export async function recommendAccountPrice(
  db: PgQueryable,
  params: Readonly<{ accountId: string; catalogItemId: string; limit?: number; offset?: number }>,
): Promise<{ items: AccountRecommendationListItem[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
  const offset = Math.max(0, params.offset ?? 0);

  const result = await db.query<AccountRecommendationListItem & { total_count: number }>(
    `SELECT
       recommendation_id,
       catalog_catalog_item_id,
       seller_account_id,
       action_type,
       status,
       listing_id,
       inventory_item_id,
       catalog_item_title,
       catalog_item_language_code,
       catalog_item_subtitle,
       catalog_item_status,
       market_price_amount,
       market_currency,
       market_signal_type,
       market_observed_at,
       current_price_amount,
       recommended_list_amount,
       recommendation_reason,
       quantity_cap,
       applied_listing_id,
       last_error,
       recommendation_published_at,
       stock_on_hand_quantity,
       stock_reserved_quantity,
       active_listing_count,
       lowest_listing_price_amount,
       active_offer_count,
       highest_offer_price_amount,
       committed_order_quantity,
       delivered_quantity,
       returned_quantity,
       updated_at,
       COUNT(*) OVER()::integer AS total_count
     FROM pricing_recommendation_feed
     WHERE seller_account_id = $1
       AND catalog_catalog_item_id = $2
       AND status IN ('proposed', 'failed')
     ORDER BY
       CASE WHEN status = 'proposed' THEN 0 ELSE 1 END,
       updated_at DESC,
       recommendation_id DESC
     LIMIT $3 OFFSET $4`,
    [params.accountId, params.catalogItemId, limit, offset],
  );

  return {
    items: result.rows.map(({ total_count: _totalCount, ...row }) => row),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

export async function explainAccountPricingSignals(
  db: PgQueryable,
  params: Readonly<{ accountId: string; catalogItemId: string; productId?: string | null }>,
): Promise<AccountRecommendationSignalExplanation> {
  const productId = params.productId?.trim() || null;
  const [inventoryResult, marketResult, orderResult, fulfillmentResult, recommendations] = await Promise.all([
    db.query<{ stock_on_hand_quantity: number; stock_reserved_quantity: number }>(
      `SELECT
         COALESCE(SUM(item.total_quantity), 0)::integer AS stock_on_hand_quantity,
         COALESCE(SUM(active_holds.held_quantity), 0)::integer AS stock_reserved_quantity
       FROM pricing_inventory_item_inputs AS item
       LEFT JOIN (
         SELECT item_id, SUM(quantity)::integer AS held_quantity
         FROM pricing_inventory_hold_inputs
         WHERE status = 'active'
         GROUP BY item_id
       ) AS active_holds ON active_holds.item_id = item.item_id
       WHERE item.seller_account_id = $1
         AND item.catalog_catalog_item_id = $2
         AND ($3::text IS NULL OR item.product_id = $3)`,
      [params.accountId, params.catalogItemId, productId],
    ),
    db.query<{
      active_listing_count: number;
      lowest_listing_price_amount: string | null;
      active_offer_count: number;
      highest_offer_price_amount: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE source = 'listing' AND status = 'active')::integer AS active_listing_count,
         MIN(price_amount) FILTER (WHERE source = 'listing' AND status = 'active')::text AS lowest_listing_price_amount,
         COUNT(*) FILTER (WHERE source = 'offer' AND status = 'submitted')::integer AS active_offer_count,
         MAX(price_amount) FILTER (WHERE source = 'offer' AND status = 'submitted')::text AS highest_offer_price_amount
       FROM (
         SELECT 'listing' AS source, status, price_amount, product_id
         FROM pricing_market_listing_inputs
         WHERE catalog_catalog_item_id = $1
         UNION ALL
         SELECT 'offer' AS source, status, price_amount, product_id
         FROM pricing_buyer_offer_inputs
         WHERE catalog_catalog_item_id = $1
       ) AS market_inputs
       WHERE ($2::text IS NULL OR product_id = $2)`,
      [params.catalogItemId, productId],
    ),
    db.query<{ committed_order_quantity: number }>(
      `SELECT COALESCE(SUM(quantity) FILTER (WHERE status = 'ready-for-fulfillment'), 0)::integer AS committed_order_quantity
       FROM pricing_order_signal_lines
       WHERE seller_account_id = $1
         AND catalog_catalog_item_id = $2
         AND ($3::text IS NULL OR product_id = $3)`,
      [params.accountId, params.catalogItemId, productId],
    ),
    db.query<{ delivered_quantity: number; returned_quantity: number }>(
      `SELECT
         COALESCE(SUM(fulfillment.quantity) FILTER (WHERE fulfillment.status = 'delivered'), 0)::integer AS delivered_quantity,
         COALESCE(SUM(fulfillment.quantity) FILTER (WHERE fulfillment.status = 'returned'), 0)::integer AS returned_quantity
       FROM pricing_fulfillment_signal_lines AS fulfillment
       INNER JOIN pricing_order_signal_lines AS order_signal
         ON order_signal.order_id = fulfillment.order_id
       WHERE order_signal.seller_account_id = $1
         AND fulfillment.catalog_catalog_item_id = $2
         AND ($3::text IS NULL OR fulfillment.product_id = $3)`,
      [params.accountId, params.catalogItemId, productId],
    ),
    recommendAccountPrice(db, { accountId: params.accountId, catalogItemId: params.catalogItemId, limit: 5 }),
  ]);

  const inventory = inventoryResult.rows[0] ?? { stock_on_hand_quantity: 0, stock_reserved_quantity: 0 };
  const market = marketResult.rows[0] ?? {
    active_listing_count: 0,
    lowest_listing_price_amount: null,
    active_offer_count: 0,
    highest_offer_price_amount: null,
  };
  const orders = orderResult.rows[0] ?? { committed_order_quantity: 0 };
  const fulfillment = fulfillmentResult.rows[0] ?? { delivered_quantity: 0, returned_quantity: 0 };

  return {
    accountId: params.accountId,
    catalogItemId: params.catalogItemId,
    productId,
    inventory: {
      stockOnHandQuantity: Number(inventory.stock_on_hand_quantity),
      stockReservedQuantity: Number(inventory.stock_reserved_quantity),
      availableQuantity: Math.max(
        0,
        Number(inventory.stock_on_hand_quantity) - Number(inventory.stock_reserved_quantity),
      ),
    },
    market: {
      activeListingCount: Number(market.active_listing_count),
      lowestListingPriceAmount:
        market.lowest_listing_price_amount === null ? null : Number(market.lowest_listing_price_amount),
      activeOfferCount: Number(market.active_offer_count),
      highestOfferPriceAmount:
        market.highest_offer_price_amount === null ? null : Number(market.highest_offer_price_amount),
    },
    orders: {
      committedOrderQuantity: Number(orders.committed_order_quantity),
    },
    fulfillment: {
      deliveredQuantity: Number(fulfillment.delivered_quantity),
      returnedQuantity: Number(fulfillment.returned_quantity),
    },
    recommendations: recommendations.items,
  };
}
