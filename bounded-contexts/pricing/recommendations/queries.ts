import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SellerRecommendationListItem = Readonly<{
  recommendation_id: string;
  catalog_item_id: string;
  seller_account_id: string;
  market_price_amount: number;
  market_currency: string;
  market_observed_at: string;
  recommended_list_amount: number | null;
  recommendation_reason: string | null;
  recommendation_published_at: string | null;
  updated_at: string;
}>;

export async function listSellerRecommendations(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: SellerRecommendationListItem[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM pricing_recommendation_pages
       WHERE seller_account_id = $1`,
      [params.sellerAccountId],
    ),
    db.query<SellerRecommendationListItem>(
      `SELECT
         recommendation_id,
         catalog_item_id,
         seller_account_id,
         market_price_amount,
         market_currency,
         market_observed_at,
         recommended_list_amount,
         recommendation_reason,
         recommendation_published_at,
         updated_at
       FROM pricing_recommendation_pages
       WHERE seller_account_id = $1
       ORDER BY updated_at DESC, recommendation_id DESC
       LIMIT $2 OFFSET $3`,
      [params.sellerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getSellerRecommendation(
  db: PgQueryable,
  recommendationId: string,
  sellerAccountId: string,
): Promise<SellerRecommendationListItem | null> {
  const result = await db.query<SellerRecommendationListItem>(
    `SELECT
       recommendation_id,
       catalog_item_id,
       seller_account_id,
       market_price_amount,
       market_currency,
       market_observed_at,
       recommended_list_amount,
       recommendation_reason,
       recommendation_published_at,
       updated_at
     FROM pricing_recommendation_pages
     WHERE recommendation_id = $1
       AND seller_account_id = $2`,
    [recommendationId, sellerAccountId],
  );

  return result.rows[0] ?? null;
}
