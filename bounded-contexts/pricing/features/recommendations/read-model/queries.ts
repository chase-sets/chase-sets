import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type AccountRecommendationListItem = Readonly<{
  recommendation_id: string;
  catalog_catalog_item_id: string;
  seller_account_id: string;
  action_type:
    | "active-listing-price-update"
    | "draft-listing-price-update"
    | "draft-listing-create";
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
