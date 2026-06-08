import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";

export type MarketplaceOfferListRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  shipping_destination_snapshot: AddressSnapshot;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_seller_average_rating?: string | null;
  accepted_seller_review_count?: number;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type OfferMatchRow = MarketplaceOfferListRow &
  Readonly<{
    listing_id: string;
    listing_price_amount: string;
    listing_quantity_cap: number;
    listing_visible_quantity: number;
    offer_price_gap_amount: string;
    offer_to_listing_price_bps: number;
    buyer_display_name: string | null;
    buyer_average_rating: string | null;
    buyer_review_count: number;
    seller_available_quantity: number;
    seller_listing_availability_status: "available" | "unavailable";
    can_fulfill: boolean;
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
  shipping_destination_snapshot: unknown;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_seller_average_rating?: string | null;
  accepted_seller_review_count?: number;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}>;

function mapOfferRow(row: MarketplaceOfferPageRow): MarketplaceOfferListRow {
  return {
    ...row,
    shipping_destination_snapshot:
      typeof row.shipping_destination_snapshot === "object" && row.shipping_destination_snapshot !== null
        ? (row.shipping_destination_snapshot as AddressSnapshot)
        : {
            name: "",
            line1: "",
            city: "",
            state: "",
            postalCode: "",
            country: "US",
          },
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

function sellerBestListingJoinSql(sellerAccountSql: string) {
  return `
  INNER JOIN LATERAL (
    SELECT
      listing.listing_id,
      listing.price_amount AS listing_price_amount,
      listing.quantity_cap AS listing_quantity_cap,
      LEAST(
        listing.quantity_cap,
        GREATEST(
          item.total_quantity - COALESCE(active_holds.held_quantity, 0),
          0
        )
      )::integer AS listing_visible_quantity
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
    WHERE listing.account_id = ${sellerAccountSql}
      AND listing.status = 'active'
      AND listing.product_id = offer.product_id
    ORDER BY
      CASE
        WHEN listing.price_amount > 0 THEN offer.price_amount / listing.price_amount
        ELSE 0
      END DESC,
      listing.price_amount ASC,
      listing.updated_at DESC,
      listing.listing_id ASC
    LIMIT 1
  ) AS matched_listing ON TRUE`;
}

function sellerOfferSelectSql(sellerAccountSql: string) {
  return `
  offer.*,
  buyer.display_name AS buyer_display_name,
  buyer.average_rating::text AS buyer_average_rating,
  COALESCE(buyer.review_count, 0)::integer AS buyer_review_count,
  matched_listing.listing_id,
  matched_listing.listing_price_amount::text AS listing_price_amount,
  matched_listing.listing_quantity_cap,
  matched_listing.listing_visible_quantity,
  matched_listing.listing_visible_quantity AS seller_available_quantity,
  (matched_listing.listing_price_amount - offer.price_amount)::numeric(12,2)::text AS offer_price_gap_amount,
  CASE
    WHEN matched_listing.listing_price_amount > 0
      THEN ROUND((offer.price_amount / matched_listing.listing_price_amount) * 10000)::integer
    ELSE 0
  END AS offer_to_listing_price_bps,
  COALESCE(availability.status, 'available') AS seller_listing_availability_status`;
}

function sellerOfferOutcomeOrderSql(tieBreakerSql: string) {
  return `
    (seller_offer.status = 'submitted'
      AND seller_offer.seller_listing_availability_status = 'available'
      AND seller_offer.seller_available_quantity >= seller_offer.quantity_requested) DESC,
    seller_offer.offer_to_listing_price_bps DESC,
    seller_offer.price_amount::numeric DESC,
    seller_offer.quantity_requested DESC,
    ${tieBreakerSql}`;
}

type OfferMatchPageRow = MarketplaceOfferPageRow & {
  listing_id: string;
  listing_price_amount: string;
  listing_quantity_cap: number;
  listing_visible_quantity: number;
  offer_price_gap_amount: string;
  offer_to_listing_price_bps: number;
  buyer_display_name: string | null;
  buyer_average_rating: string | null;
  buyer_review_count: number;
  seller_available_quantity: number;
  seller_listing_availability_status: "available" | "unavailable" | null | undefined;
};

type OfferMatchForSellerPageRow = OfferMatchPageRow & {
  seller_account_id: string;
};

function mapOfferMatchRow(row: OfferMatchPageRow): OfferMatchRow {
  const offer = mapOfferRow(row);

  return {
    ...offer,
    listing_id: row.listing_id,
    listing_price_amount: row.listing_price_amount,
    listing_quantity_cap: row.listing_quantity_cap,
    listing_visible_quantity: row.listing_visible_quantity,
    offer_price_gap_amount: row.offer_price_gap_amount,
    offer_to_listing_price_bps: row.offer_to_listing_price_bps,
    buyer_display_name: row.buyer_display_name,
    buyer_average_rating: row.buyer_average_rating,
    buyer_review_count: row.buyer_review_count,
    seller_available_quantity: row.seller_available_quantity,
    seller_listing_availability_status: row.seller_listing_availability_status ?? "available",
    can_fulfill:
      (row.seller_listing_availability_status ?? "available") === "available" &&
      offer.status === "submitted" &&
      row.seller_available_quantity >= offer.quantity_requested,
  };
}

export async function listSubmittedOffers(
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
      `SELECT
         offer.*,
         seller.average_rating::text AS accepted_seller_average_rating,
         COALESCE(seller.review_count, 0)::integer AS accepted_seller_review_count
       FROM marketplace_offer_pages AS offer
       LEFT JOIN marketplace_account_pages AS seller
         ON seller.account_id = offer.accepted_seller_account_id
       WHERE offer.buyer_account_id = $1
       ORDER BY offer.updated_at DESC, offer.offer_id DESC
       LIMIT $2 OFFSET $3`,
      [params.buyerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map(mapOfferRow),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getSubmittedOffer(
  db: PgQueryable,
  offerId: string,
  buyerAccountId: string,
): Promise<MarketplaceOfferListRow | null> {
  const result = await db.query<MarketplaceOfferPageRow>(
    `SELECT
       offer.*,
       seller.average_rating::text AS accepted_seller_average_rating,
       COALESCE(seller.review_count, 0)::integer AS accepted_seller_review_count
     FROM marketplace_offer_pages AS offer
     LEFT JOIN marketplace_account_pages AS seller
       ON seller.account_id = offer.accepted_seller_account_id
     WHERE offer.offer_id = $1
       AND offer.buyer_account_id = $2`,
    [offerId, buyerAccountId],
  );

  const row = result.rows[0];
  return row ? mapOfferRow(row) : null;
}

export async function listOfferMatches(
  db: PgQueryable,
  params: Readonly<{
    sellerAccountId: string;
    limit?: number;
    offset?: number;
    productIds?: readonly string[];
    status?: "submitted";
    canFulfill?: boolean;
  }>,
): Promise<{ items: OfferMatchRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const productIds = [...new Set((params.productIds ?? []).map((value) => value.trim()).filter(Boolean))];
  const innerWhere = [`offer.status = 'submitted'`, sellerVisibilitySql];
  const innerValues: unknown[] = [params.sellerAccountId];
  if (productIds.length > 0) {
    innerValues.push(productIds);
    innerWhere.push(`offer.product_id = ANY($${innerValues.length}::text[])`);
  }
  const fulfillableWhere =
    params.canFulfill === true
      ? `seller_offer.seller_listing_availability_status = 'available'
         AND seller_offer.seller_available_quantity >= seller_offer.quantity_requested`
      : `TRUE`;
  const innerSql = `
    SELECT
      ${sellerOfferSelectSql("$1")}
    FROM marketplace_offer_pages AS offer
    ${sellerBestListingJoinSql("$1")}
    LEFT JOIN marketplace_account_pages AS buyer
      ON buyer.account_id = offer.buyer_account_id
    LEFT JOIN marketplace_seller_listing_availability_pages AS availability
      ON availability.account_id = $1
    WHERE ${innerWhere.join("\n      AND ")}`;

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM (${innerSql}) AS seller_offer
       WHERE ${fulfillableWhere}`,
      innerValues,
    ),
    db.query<OfferMatchPageRow>(
      `SELECT *
       FROM (${innerSql}) AS seller_offer
       WHERE ${fulfillableWhere}
       ORDER BY
         ${sellerOfferOutcomeOrderSql("seller_offer.created_at ASC, seller_offer.offer_id ASC")}
       LIMIT $${innerValues.length + 1} OFFSET $${innerValues.length + 2}`,
      [...innerValues, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map(mapOfferMatchRow),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getOfferMatch(
  db: PgQueryable,
  offerId: string,
  sellerAccountId: string,
): Promise<OfferMatchRow | null> {
  const result = await db.query<OfferMatchPageRow>(
    `SELECT
       ${sellerOfferSelectSql("$1")}
     FROM marketplace_offer_pages AS offer
     ${sellerBestListingJoinSql("$1")}
     LEFT JOIN marketplace_account_pages AS buyer
       ON buyer.account_id = offer.buyer_account_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = $1
     WHERE offer.offer_id = $2
       AND offer.status = 'submitted'
       AND ${sellerVisibilitySql}`,
    [sellerAccountId, offerId],
  );

  const row = result.rows[0];

  return row ? mapOfferMatchRow(row) : null;
}

export async function listOfferMatchesForSellers(
  db: PgQueryable,
  offerId: string,
  sellerAccountIds: readonly string[],
): Promise<ReadonlyMap<string, OfferMatchRow>> {
  const uniqueSellerAccountIds = [...new Set(sellerAccountIds)];
  if (uniqueSellerAccountIds.length === 0) {
    return new Map();
  }

  const result = await db.query<OfferMatchForSellerPageRow>(
    `WITH seller_accounts AS (
       SELECT DISTINCT unnest($2::text[]) AS seller_account_id
     )
     SELECT
       seller_account.seller_account_id,
       ${sellerOfferSelectSql("seller_account.seller_account_id")}
     FROM seller_accounts AS seller_account
     INNER JOIN marketplace_offer_pages AS offer
       ON offer.offer_id = $1
     ${sellerBestListingJoinSql("seller_account.seller_account_id")}
     LEFT JOIN marketplace_account_pages AS buyer
       ON buyer.account_id = offer.buyer_account_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = seller_account.seller_account_id
     WHERE offer.status = 'submitted'
       AND EXISTS (
         SELECT 1
         FROM marketplace_listing_pages AS listing
         WHERE listing.account_id = seller_account.seller_account_id
           AND listing.status = 'active'
           AND listing.product_id = offer.product_id
       )`,
    [offerId, uniqueSellerAccountIds],
  );

  return new Map(result.rows.map((row) => [row.seller_account_id, mapOfferMatchRow(row)]));
}
