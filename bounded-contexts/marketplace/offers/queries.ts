import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type MarketplaceOfferListRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_item_id: string;
  item_title: string;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  created_at: string;
  updated_at: string;
}>;

export type MarketplaceSellerOfferRow = MarketplaceOfferListRow &
  Readonly<{
    buyer_display_name: string | null;
  }>;

type MarketplaceOfferPageRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_item_id: string;
  item_title: string;
  item_subtitle: string | null;
  version_selection: unknown;
  version_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  created_at: string;
  updated_at: string;
}>;

function mapOfferRow(row: MarketplaceOfferPageRow): MarketplaceOfferListRow {
  return {
    ...row,
    version_selection: Array.isArray(row.version_selection)
      ? (row.version_selection as MarketplaceOfferListRow["version_selection"])
      : [],
  };
}

const sellerVisibilitySql = `
EXISTS (
  SELECT 1
  FROM marketplace_listing_pages AS listing
  WHERE listing.account_id = $1
    AND listing.status = 'active'
    AND listing.catalog_item_id = offer.catalog_item_id
    AND listing.version_selection @> offer.version_selection
    AND offer.version_selection @> listing.version_selection
)`;

export async function listBuyerOffers(
  db: PgQueryable,
  params: Readonly<{ buyerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: MarketplaceOfferListRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_offer_pages
       WHERE buyer_account_id = $1`,
      [params.buyerAccountId],
    ),
    db.query<MarketplaceOfferPageRow>(
      `SELECT *
       FROM marketplace_offer_pages
       WHERE buyer_account_id = $1
       ORDER BY updated_at DESC, offer_id DESC
       LIMIT $2 OFFSET $3`,
      [params.buyerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map(mapOfferRow),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getBuyerOffer(
  db: PgQueryable,
  offerId: string,
  buyerAccountId: string,
): Promise<MarketplaceOfferListRow | null> {
  const result = await db.query<MarketplaceOfferPageRow>(
    `SELECT *
     FROM marketplace_offer_pages
     WHERE offer_id = $1
       AND buyer_account_id = $2`,
    [offerId, buyerAccountId],
  );

  const row = result.rows[0];
  return row ? mapOfferRow(row) : null;
}

export async function listSellerVisibleOffers(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: MarketplaceSellerOfferRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_offer_pages AS offer
       WHERE offer.status = 'submitted'
         AND ${sellerVisibilitySql}`,
      [params.sellerAccountId],
    ),
    db.query<
      MarketplaceOfferPageRow & {
        buyer_display_name: string | null;
      }
    >(
      `SELECT
         offer.*,
         buyer.display_name AS buyer_display_name
       FROM marketplace_offer_pages AS offer
       LEFT JOIN identity_accounts AS buyer
         ON buyer.account_id = offer.buyer_account_id
       WHERE offer.status = 'submitted'
         AND ${sellerVisibilitySql}
       ORDER BY offer.updated_at DESC, offer.offer_id DESC
       LIMIT $2 OFFSET $3`,
      [params.sellerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map((row) => ({
      ...mapOfferRow(row),
      buyer_display_name: row.buyer_display_name,
    })),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getSellerVisibleOffer(
  db: PgQueryable,
  offerId: string,
  sellerAccountId: string,
): Promise<MarketplaceSellerOfferRow | null> {
  const result = await db.query<
    MarketplaceOfferPageRow & {
      buyer_display_name: string | null;
    }
  >(
    `SELECT
       offer.*,
       buyer.display_name AS buyer_display_name
     FROM marketplace_offer_pages AS offer
     LEFT JOIN identity_accounts AS buyer
       ON buyer.account_id = offer.buyer_account_id
     WHERE offer.offer_id = $2
       AND offer.status = 'submitted'
       AND ${sellerVisibilitySql}`,
    [sellerAccountId, offerId],
  );

  const row = result.rows[0];

  return row
    ? {
        ...mapOfferRow(row),
        buyer_display_name: row.buyer_display_name,
      }
    : null;
}
