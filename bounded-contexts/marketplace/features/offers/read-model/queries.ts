import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type MarketplaceOfferListRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type BuyerOfferMatchRow = MarketplaceOfferListRow &
  Readonly<{
    buyer_display_name: string | null;
    seller_available_quantity: number;
    can_fulfill: boolean;
    in_sell_list: boolean;
  }>;

type MarketplaceOfferPageRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}>;

function mapOfferRow(row: MarketplaceOfferPageRow): MarketplaceOfferListRow {
  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as MarketplaceOfferListRow["selected_options"])
      : [],
  };
}

const sellerVisibilitySql = `
(
  (
    offer.status = 'submitted'
    AND EXISTS (
      SELECT 1
      FROM marketplace_listing_pages AS listing
      WHERE listing.account_id = $1
        AND listing.status = 'active'
        AND listing.product_id = offer.product_id
    )
  )
  OR (
    offer.status = 'accepted'
    AND offer.accepted_seller_account_id = $1
  )
)`;

const sellerOfferSelectSql = `
  offer.*,
  buyer.display_name AS buyer_display_name,
  COALESCE((
    SELECT SUM(
      LEAST(
        listing.quantity_cap,
        GREATEST(
          item.total_quantity - COALESCE(active_holds.held_quantity, 0),
          0
        )
      )
    )::integer
    FROM marketplace_listing_pages AS listing
    INNER JOIN marketplace_supply_items AS item
      ON item.item_id = listing.inventory_item_id
    LEFT JOIN (
      SELECT item_id, SUM(quantity)::integer AS held_quantity
      FROM marketplace_supply_holds
      WHERE status = 'active'
      GROUP BY item_id
    ) AS active_holds
      ON active_holds.item_id = item.item_id
    WHERE listing.account_id = $1
      AND listing.status = 'active'
      AND listing.product_id = offer.product_id
  ), 0)::integer AS seller_available_quantity,
  EXISTS (
    SELECT 1
    FROM marketplace_buyer_offer_match_sell_list_pages AS cart
    WHERE cart.seller_account_id = $1
      AND cart.offer_id = offer.offer_id
  ) AS in_sell_list`;

function sellerOfferOutcomeOrderSql(tieBreakerSql: string) {
  return `
    (seller_offer.status = 'submitted'
      AND seller_offer.seller_available_quantity >= seller_offer.quantity_requested) DESC,
    seller_offer.price_amount::numeric DESC,
    seller_offer.quantity_requested DESC,
    ${tieBreakerSql}`;
}

type BuyerOfferMatchPageRow = MarketplaceOfferPageRow & {
  buyer_display_name: string | null;
  seller_available_quantity: number;
  in_sell_list: boolean;
};

function mapBuyerOfferMatchRow(row: BuyerOfferMatchPageRow): BuyerOfferMatchRow {
  const offer = mapOfferRow(row);

  return {
    ...offer,
    buyer_display_name: row.buyer_display_name,
    seller_available_quantity: row.seller_available_quantity,
    can_fulfill:
      offer.status === "submitted" &&
      row.seller_available_quantity >= offer.quantity_requested,
    in_sell_list: row.in_sell_list,
  };
}

export async function listSubmittedBuyerOffers(
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

export async function getSubmittedBuyerOffer(
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

export async function listBuyerOfferMatches(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: BuyerOfferMatchRow[]; total: number }> {
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
    db.query<BuyerOfferMatchPageRow>(
      `SELECT *
       FROM (
         SELECT
           ${sellerOfferSelectSql}
         FROM marketplace_offer_pages AS offer
         LEFT JOIN marketplace_account_pages AS buyer
           ON buyer.account_id = offer.buyer_account_id
         WHERE offer.status = 'submitted'
           AND ${sellerVisibilitySql}
       ) AS seller_offer
       ORDER BY
         ${sellerOfferOutcomeOrderSql(
           "seller_offer.created_at ASC, seller_offer.offer_id ASC",
         )}
       LIMIT $2 OFFSET $3`,
      [params.sellerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map(mapBuyerOfferMatchRow),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getBuyerOfferMatch(
  db: PgQueryable,
  offerId: string,
  sellerAccountId: string,
): Promise<BuyerOfferMatchRow | null> {
  const result = await db.query<BuyerOfferMatchPageRow>(
    `SELECT
       ${sellerOfferSelectSql}
     FROM marketplace_offer_pages AS offer
     LEFT JOIN marketplace_account_pages AS buyer
       ON buyer.account_id = offer.buyer_account_id
     WHERE offer.offer_id = $2
       AND offer.status = 'submitted'
       AND ${sellerVisibilitySql}`,
    [sellerAccountId, offerId],
  );

  const row = result.rows[0];

  return row ? mapBuyerOfferMatchRow(row) : null;
}

export async function addBuyerOfferMatchSellListItem(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; offerId: string; addedAt: string }>,
): Promise<void> {
  const offer = await getBuyerOfferMatch(db, params.offerId, params.sellerAccountId);
  if (!offer) {
    throw new Error("Offer not found.");
  }

  await db.query(
    `INSERT INTO marketplace_buyer_offer_match_sell_list_pages (
       seller_account_id,
       offer_id,
       added_at,
       updated_at
     ) VALUES ($1, $2, $3, $3)
     ON CONFLICT (seller_account_id, offer_id) DO UPDATE SET
       updated_at = EXCLUDED.updated_at`,
    [params.sellerAccountId, params.offerId, params.addedAt],
  );
}

export async function listBuyerOfferMatchSellList(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<BuyerOfferMatchRow[]> {
  const result = await db.query<BuyerOfferMatchPageRow>(
    `SELECT *
     FROM (
       SELECT
         ${sellerOfferSelectSql},
         cart.updated_at AS cart_updated_at
       FROM marketplace_buyer_offer_match_sell_list_pages AS cart
       INNER JOIN marketplace_offer_pages AS offer
         ON offer.offer_id = cart.offer_id
       LEFT JOIN marketplace_account_pages AS buyer
         ON buyer.account_id = offer.buyer_account_id
       WHERE cart.seller_account_id = $1
     ) AS seller_offer
     ORDER BY
       ${sellerOfferOutcomeOrderSql("seller_offer.cart_updated_at DESC")}`,
    [sellerAccountId],
  );

  return result.rows.map(mapBuyerOfferMatchRow);
}

export async function removeBuyerOfferMatchSellListItems(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; offerIds: readonly string[] }>,
): Promise<void> {
  if (params.offerIds.length === 0) {
    return;
  }

  await db.query(
    `DELETE FROM marketplace_buyer_offer_match_sell_list_pages
     WHERE seller_account_id = $1
       AND offer_id = ANY($2)`,
    [params.sellerAccountId, params.offerIds],
  );
}
