import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";

export type MarketplaceOfferListRow = Readonly<{
  offers_away?: boolean;
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
  price_currency_code: string | null;
  last_stream_version: number;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_listing_id: string | null;
  accepted_inventory_item_id: string | null;
  listing_evidence_policy_hash: string | null;
  listing_evidence_snapshot_hash: string | null;
  accepted_seller_average_rating?: string | null;
  accepted_seller_review_count?: number;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}>;

type OfferMatchBuyerFields = Readonly<{
  buyer_display_name: string | null;
  buyer_average_rating: string | null;
  buyer_review_count: number;
  managed_status?: "unavailable" | "held" | "refresh_required" | null;
}>;

export type ListingOfferMatchRow = MarketplaceOfferListRow &
  OfferMatchBuyerFields &
  Readonly<{
    fill_source: "listing";
    listing_id: string;
    listing_price_amount: string;
    listing_price_currency_code: string;
    listing_stream_version: number;
    listing_quantity_cap: number;
    listing_visible_quantity: number;
    offer_price_gap_amount: string;
    offer_to_listing_price_bps: number;
    seller_available_quantity: number;
    seller_listing_availability_status: "available" | "unavailable";
    can_fulfill: boolean;
  }>;

/** A Match the seller could fill from inventory; it carries no Listing keys and cannot be accepted until listed. */
export type InventoryOfferMatchRow = MarketplaceOfferListRow &
  OfferMatchBuyerFields &
  Readonly<{
    fill_source: "inventory";
    can_fulfill: false;
    inventory_item_id: string;
    inventory_available_quantity: number;
  }>;

export type OfferMatchRow = ListingOfferMatchRow | InventoryOfferMatchRow;

type MarketplaceOfferPageRow = Readonly<{
  offers_away?: boolean;
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
  price_currency_code: string | null;
  last_stream_version: number;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_listing_id: string | null;
  accepted_inventory_item_id: string | null;
  listing_evidence_policy_hash: string | null;
  listing_evidence_snapshot_hash: string | null;
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

const sellerVisibilitySql = (checkProjectedOffersAway = true) => `
(
  (
    ${buyerVisibleOfferPredicateSql("offer", "buyer", checkProjectedOffersAway)}
    AND EXISTS (
      SELECT 1
      FROM marketplace_listing_pages AS listing
      WHERE listing.account_id = $1
        AND listing.status = 'active'
        AND listing.product_id = offer.product_id
        AND listing.price_currency_code IS NOT NULL
        AND offer.price_currency_code IS NOT NULL
        AND listing.price_currency_code = offer.price_currency_code
        AND listing.listing_stream_version > 0
        AND offer.last_stream_version > 0
    )
  )
  OR (
    offer.status = 'accepted'
    AND offer.accepted_seller_account_id = $1
  )
)`;

/**
 * Joins the seller's best qualifying Listing and, only when there is none, their inventory item with the most
 * available quantity. Pair with sellerMatchSourceWhereSql so an Offer matches from either source.
 */
function sellerMatchSourceJoinSql(sellerAccountSql: string) {
  return `
  LEFT JOIN LATERAL (
    SELECT
      listing.listing_id,
      listing.price_amount AS listing_price_amount,
      listing.price_currency_code AS listing_price_currency_code,
      listing.listing_stream_version,
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
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(supply_hold.quantity), 0)::integer AS held_quantity
      FROM marketplace_supply_holds AS supply_hold
      WHERE supply_hold.item_id = item.item_id
        AND supply_hold.status = 'active'
    ) AS active_holds ON TRUE
    WHERE listing.account_id = ${sellerAccountSql}
      AND listing.status = 'active'
      AND listing.product_id = offer.product_id
      AND listing.price_currency_code IS NOT NULL
      AND offer.price_currency_code IS NOT NULL
      AND listing.price_currency_code = offer.price_currency_code
      AND listing.listing_stream_version > 0
      AND offer.last_stream_version > 0
    ORDER BY
      CASE
        WHEN listing.price_amount > 0 THEN offer.price_amount / listing.price_amount
        ELSE 0
      END DESC,
      listing.price_amount ASC,
      listing.updated_at DESC,
      listing.listing_id ASC
    LIMIT 1
  ) AS matched_listing ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      inventory_item.item_id AS inventory_item_id,
      (inventory_item.total_quantity - COALESCE(inventory_holds.held_quantity, 0))::integer
        AS inventory_available_quantity
    FROM marketplace_supply_items AS inventory_item
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(supply_hold.quantity), 0)::integer AS held_quantity
      FROM marketplace_supply_holds AS supply_hold
      WHERE supply_hold.item_id = inventory_item.item_id
        AND supply_hold.status = 'active'
    ) AS inventory_holds ON TRUE
    WHERE matched_listing.listing_id IS NULL
      AND inventory_item.account_id = ${sellerAccountSql}
      AND inventory_item.product_id = offer.product_id
      AND inventory_item.total_quantity - COALESCE(inventory_holds.held_quantity, 0) > 0
    ORDER BY inventory_available_quantity DESC, inventory_item.item_id ASC
    LIMIT 1
  ) AS matched_inventory ON TRUE`;
}

/** The Match source rule shared by listOfferMatches, getOfferMatch and listOfferMatchesForSellers. */
function sellerMatchSourceWhereSql(sellerAccountSql: string) {
  return `${buyerVisibleOfferPredicateSql("offer", "buyer")}
    AND offer.buyer_account_id <> ${sellerAccountSql}
    AND (matched_listing.listing_id IS NOT NULL OR matched_inventory.inventory_item_id IS NOT NULL)`;
}

const sellerMatchSourceSelectSql = `
  CASE WHEN matched_listing.listing_id IS NOT NULL THEN 'listing' ELSE 'inventory' END AS fill_source,
  matched_inventory.inventory_item_id,
  matched_inventory.inventory_available_quantity`;

function sellerExactListingJoinSql(sellerAccountSql: string, listingIdSql: string) {
  return `
  INNER JOIN LATERAL (
    SELECT
      listing.listing_id,
      listing.price_amount AS listing_price_amount,
      listing.price_currency_code AS listing_price_currency_code,
      listing.listing_stream_version,
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
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(supply_hold.quantity), 0)::integer AS held_quantity
      FROM marketplace_supply_holds AS supply_hold
      WHERE supply_hold.item_id = item.item_id
        AND supply_hold.status = 'active'
    ) AS active_holds ON TRUE
    WHERE listing.account_id = ${sellerAccountSql}
      AND listing.listing_id = ${listingIdSql}
      AND listing.status = 'active'
      AND listing.product_id = offer.product_id
      AND listing.price_currency_code IS NOT NULL
      AND offer.price_currency_code IS NOT NULL
      AND listing.price_currency_code = offer.price_currency_code
      AND listing.listing_stream_version > 0
      AND offer.last_stream_version > 0
    LIMIT 1
  ) AS matched_listing ON TRUE`;
}

function sellerOfferControlsJoinSql(sellerAccountSql: string) {
  return `
    LEFT JOIN LATERAL (
      SELECT offer_id, policy_id FROM marketplace_buyer_offer_policy_memberships WHERE offer_id = offer.offer_id
      UNION
      SELECT offer.offer_id, binding.payload->>'policyId' FROM event_store_events AS binding
      WHERE binding.stream_id = 'marketplace.offer-' || offer.offer_id
        AND binding.event_type = 'marketplace.offer.buyer-policy-bound'
      LIMIT 1
    ) AS membership ON TRUE
    LEFT JOIN marketplace_buyer_offer_policy_pages AS policy ON policy.policy_id = membership.policy_id
    LEFT JOIN event_store_streams AS policy_stream ON policy_stream.stream_id = 'marketplace.offer-policy-' || membership.policy_id
    LEFT JOIN marketplace_managed_offer_audit AS evaluation ON evaluation.offer_id = offer.offer_id
    LEFT JOIN LATERAL (
      SELECT selected.value->'result' AS result
      FROM event_store_events AS consent
      CROSS JOIN LATERAL jsonb_array_elements(consent.payload->'outcomes') AS selected(value)
      WHERE consent.stream_id = 'marketplace.offer-policy-' || membership.policy_id
        AND consent.event_type = 'marketplace.offer-policy.authorized'
        AND consent.payload->>'revision' = policy.state->>'revision'
        AND selected.value->>'offerId' = offer.offer_id
      ORDER BY consent.stream_version DESC LIMIT 1
    ) AS consent_target ON TRUE
    LEFT JOIN marketplace_offer_seller_declines AS seller_offer_decline
      ON seller_offer_decline.seller_account_id = ${sellerAccountSql}
     AND seller_offer_decline.offer_id = offer.offer_id`;
}

function sellerOfferControlsWhereSql() {
  return `seller_offer_decline.offer_id IS NULL`;
}

function sellerOfferSelectSql(sellerAccountSql: string) {
  return `
  offer.*,
  buyer.display_name AS buyer_display_name,
  buyer.average_rating_as_buyer::text AS buyer_average_rating,
  COALESCE(buyer.rating_count_as_buyer, 0)::integer AS buyer_review_count,
  matched_listing.listing_id,
  matched_listing.listing_price_amount::text AS listing_price_amount,
  matched_listing.listing_price_currency_code,
  matched_listing.listing_stream_version,
  matched_listing.listing_quantity_cap,
  matched_listing.listing_visible_quantity,
  matched_listing.listing_visible_quantity AS seller_available_quantity,
  (matched_listing.listing_price_amount - offer.price_amount)::numeric(12,2)::text AS offer_price_gap_amount,
  CASE
    WHEN matched_listing.listing_price_amount > 0
      THEN ROUND((offer.price_amount / matched_listing.listing_price_amount) * 10000)::integer
    ELSE 0
  END AS offer_to_listing_price_bps,
  COALESCE(availability.status, 'available') AS seller_listing_availability_status,
  CASE
    WHEN membership.offer_id IS NULL THEN NULL
    WHEN policy.state->>'status' IS DISTINCT FROM 'active' THEN 'unavailable'
    WHEN policy.last_stream_version IS DISTINCT FROM policy_stream.current_version THEN 'refresh_required'
    WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy.state->'authority'->'offers') selected
                     WHERE selected->>'offerId' = offer.offer_id) THEN 'unavailable'
    WHEN evaluation.evidence->>'policyRevision' = policy.state->>'revision'
         AND evaluation.status = 'held' THEN 'held'
    WHEN evaluation.evidence->>'policyRevision' = policy.state->>'revision'
         AND evaluation.status = 'applied' AND evaluation.reason = 'market-price-target'
         AND evaluation.last_stream_version = offer.last_stream_version
         AND (evaluation.evidence->'marketPrice'->>'freshUntil')::timestamptz > now() THEN NULL
    WHEN consent_target.result->>'status' = 'held' THEN 'held'
    WHEN consent_target.result->>'status' = 'target'
         AND consent_target.result->>'unitItemAmount' = offer.price_amount::numeric(12,2)::text
         AND (consent_target.result->'evidence'->'marketPrice'->>'freshUntil')::timestamptz > now()
         AND (evaluation.offer_id IS NULL OR evaluation.evidence->>'policyRevision' IS DISTINCT FROM policy.state->>'revision') THEN NULL
    ELSE 'refresh_required'
  END AS managed_status`;
}

function buyerVisibleOfferPredicateSql(offerAlias: string, accountAlias: string, checkProjectedOffersAway = true) {
  return `${offerAlias}.status = 'submitted'
    AND ${offerAlias}.price_currency_code IS NOT NULL
    AND ${offerAlias}.last_stream_version > 0
    AND ${accountAlias}.status = 'active'${
      checkProjectedOffersAway
        ? `
    AND NOT EXISTS (
      SELECT 1 FROM marketplace_seller_listing_availability_pages AS buyer_availability
      WHERE buyer_availability.account_id = ${offerAlias}.buyer_account_id
        AND buyer_availability.offers_status = 'unavailable'
    )`
        : ""
    }`;
}

function sellerOfferOutcomeOrderSql(tieBreakerSql: string) {
  return `
    (seller_offer.status = 'submitted'
      AND seller_offer.seller_listing_availability_status = 'available'
      AND seller_offer.managed_status IS NULL
      AND seller_offer.seller_available_quantity >= seller_offer.quantity_requested) DESC,
    seller_offer.offer_to_listing_price_bps DESC,
    seller_offer.price_currency_code ASC,
    seller_offer.price_amount::numeric DESC,
    seller_offer.quantity_requested DESC,
    ${tieBreakerSql}`;
}

/** Listing Matches keep their outcome order; inventory Matches follow, covering stock first, then Offer price. */
function sellerMatchOrderSql() {
  const inventory = (expression: string) => `CASE WHEN seller_offer.fill_source = 'inventory' THEN ${expression} END`;
  return `
    (seller_offer.fill_source = 'inventory') ASC,
    ${inventory("seller_offer.inventory_available_quantity >= seller_offer.quantity_requested")} DESC NULLS LAST,
    ${inventory("seller_offer.price_amount::numeric")} DESC NULLS LAST,
    ${inventory("seller_offer.created_at")} ASC,
    ${inventory("seller_offer.offer_id")} ASC,
    ${sellerOfferOutcomeOrderSql("seller_offer.created_at ASC, seller_offer.offer_id ASC")}`;
}

type OfferMatchPageRow = MarketplaceOfferPageRow & {
  fill_source?: "listing" | "inventory" | null;
  inventory_item_id?: string | null;
  inventory_available_quantity?: number | null;
  listing_id: string;
  listing_price_amount: string;
  listing_price_currency_code: string;
  listing_stream_version: number;
  listing_quantity_cap: number;
  listing_visible_quantity: number;
  offer_price_gap_amount: string;
  offer_to_listing_price_bps: number;
  buyer_display_name: string | null;
  buyer_average_rating: string | null;
  buyer_review_count: number;
  seller_available_quantity: number;
  seller_listing_availability_status: "available" | "unavailable" | null | undefined;
  managed_status?: "unavailable" | "held" | "refresh_required" | null;
};

type OfferMatchForSellerPageRow = OfferMatchPageRow & {
  seller_account_id: string;
};

function mapOfferMatchRow(row: OfferMatchPageRow): OfferMatchRow {
  if (row.fill_source !== "inventory") return mapListingOfferMatchRow(row);
  const {
    fill_source: _fillSource,
    inventory_item_id,
    inventory_available_quantity,
    listing_id: _listingId,
    listing_price_amount: _listingPriceAmount,
    listing_price_currency_code: _listingPriceCurrencyCode,
    listing_stream_version: _listingStreamVersion,
    listing_quantity_cap: _listingQuantityCap,
    listing_visible_quantity: _listingVisibleQuantity,
    offer_price_gap_amount: _offerPriceGapAmount,
    offer_to_listing_price_bps: _offerToListingPriceBps,
    seller_available_quantity: _sellerAvailableQuantity,
    seller_listing_availability_status: _sellerListingAvailabilityStatus,
    ...offerColumns
  } = row;

  return {
    ...mapOfferRow(offerColumns),
    buyer_display_name: row.buyer_display_name,
    buyer_average_rating: row.buyer_average_rating,
    buyer_review_count: row.buyer_review_count,
    managed_status: row.managed_status ?? null,
    fill_source: "inventory",
    can_fulfill: false,
    inventory_item_id: inventory_item_id!,
    inventory_available_quantity: inventory_available_quantity!,
  };
}

function mapListingOfferMatchRow(row: OfferMatchPageRow): ListingOfferMatchRow {
  const {
    fill_source: _fillSource,
    inventory_item_id: _inventoryItemId,
    inventory_available_quantity: _inventoryAvailableQuantity,
    ...listingColumns
  } = row;
  const offer = mapOfferRow(listingColumns);

  return {
    ...offer,
    fill_source: "listing",
    listing_id: row.listing_id,
    listing_price_amount: row.listing_price_amount,
    listing_price_currency_code: row.listing_price_currency_code,
    listing_stream_version: row.listing_stream_version,
    listing_quantity_cap: row.listing_quantity_cap,
    listing_visible_quantity: row.listing_visible_quantity,
    offer_price_gap_amount: row.offer_price_gap_amount,
    offer_to_listing_price_bps: row.offer_to_listing_price_bps,
    buyer_display_name: row.buyer_display_name,
    buyer_average_rating: row.buyer_average_rating,
    buyer_review_count: row.buyer_review_count,
    seller_available_quantity: row.seller_available_quantity,
    seller_listing_availability_status: row.seller_listing_availability_status ?? "available",
    managed_status: row.managed_status ?? null,
    can_fulfill:
      row.managed_status == null &&
      (row.seller_listing_availability_status ?? "available") === "available" &&
      offer.status === "submitted" &&
      row.seller_available_quantity >= offer.quantity_requested,
  };
}

export const submittedOfferStatuses = ["submitted", "paused", "withdrawn", "accepted"] as const;
export type SubmittedOfferStatus = (typeof submittedOfferStatuses)[number];
export type SubmittedOfferStatusCounts = Readonly<Record<SubmittedOfferStatus, number>>;

export function parseSubmittedOfferStatus(value: unknown): SubmittedOfferStatus | undefined {
  return submittedOfferStatuses.find((status) => status === value);
}

export async function listSubmittedOffers(
  db: PgQueryable,
  params: Readonly<{ buyerAccountId: string; limit?: number; offset?: number; status?: SubmittedOfferStatus }>,
): Promise<{ items: MarketplaceOfferListRow[]; total: number; statusCounts: SubmittedOfferStatusCounts }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const status = params.status ?? null;

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) AS count
       FROM marketplace_offer_pages
       WHERE buyer_account_id = $1
       GROUP BY status`,
      [params.buyerAccountId],
    ),
    db.query<MarketplaceOfferPageRow>(
      `SELECT
         offer.*,
         COALESCE(availability.offers_status = 'unavailable', FALSE) AS offers_away,
         seller.average_rating_as_seller::text AS accepted_seller_average_rating,
         COALESCE(seller.rating_count_as_seller, 0)::integer AS accepted_seller_review_count
       FROM marketplace_offer_pages AS offer
       LEFT JOIN marketplace_account_pages AS seller
         ON seller.account_id = offer.accepted_seller_account_id
       LEFT JOIN marketplace_seller_listing_availability_pages AS availability
         ON availability.account_id = offer.buyer_account_id
       WHERE offer.buyer_account_id = $1
         AND ($4::text IS NULL OR offer.status = $4)
       ORDER BY offer.updated_at DESC, offer.offer_id DESC
       LIMIT $2 OFFSET $3`,
      [params.buyerAccountId, limit, offset, status],
    ),
  ]);
  const counted = new Map(countResult.rows.map((row) => [row.status, Number(row.count)]));
  const statusCounts = Object.fromEntries(
    submittedOfferStatuses.map((value) => [value, counted.get(value) ?? 0]),
  ) as SubmittedOfferStatusCounts;

  return {
    items: itemsResult.rows.map(mapOfferRow),
    total: status ? statusCounts[status] : [...counted.values()].reduce((sum, count) => sum + count, 0),
    statusCounts,
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
       COALESCE(availability.offers_status = 'unavailable', FALSE) AS offers_away,
       seller.average_rating_as_seller::text AS accepted_seller_average_rating,
       COALESCE(seller.rating_count_as_seller, 0)::integer AS accepted_seller_review_count
     FROM marketplace_offer_pages AS offer
     LEFT JOIN marketplace_account_pages AS seller
       ON seller.account_id = offer.accepted_seller_account_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = offer.buyer_account_id
     WHERE offer.offer_id = $1
       AND offer.buyer_account_id = $2`,
    [offerId, buyerAccountId],
  );

  const row = result.rows[0];
  return row ? mapOfferRow(row) : null;
}

export async function getPublicOffer(db: PgQueryable, offerId: string): Promise<MarketplaceOfferListRow | null> {
  const result = await db.query<MarketplaceOfferPageRow>(
    `SELECT
       offer.*,
       seller.average_rating_as_seller::text AS accepted_seller_average_rating,
       COALESCE(seller.rating_count_as_seller, 0)::integer AS accepted_seller_review_count
     FROM marketplace_offer_pages AS offer
     LEFT JOIN marketplace_account_pages AS seller
       ON seller.account_id = offer.accepted_seller_account_id
     LEFT JOIN marketplace_account_pages AS buyer
       ON buyer.account_id = offer.buyer_account_id
     WHERE offer.offer_id = $1
       AND ${buyerVisibleOfferPredicateSql("offer", "buyer")}`,
    [offerId],
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
  const innerWhere = [`offer.status = 'submitted'`, sellerMatchSourceWhereSql("$1")];
  const innerValues: unknown[] = [params.sellerAccountId];
  if (productIds.length > 0) {
    innerValues.push(productIds);
    innerWhere.push(`offer.product_id = ANY($${innerValues.length}::text[])`);
  }
  const fulfillableWhere =
    params.canFulfill === true
      ? `seller_offer.fill_source = 'listing'
         AND seller_offer.seller_listing_availability_status = 'available'
         AND seller_offer.managed_status IS NULL
         AND seller_offer.seller_available_quantity >= seller_offer.quantity_requested`
      : `TRUE`;
  const innerSql = `
    SELECT
      ${sellerOfferSelectSql("$1")},
      ${sellerMatchSourceSelectSql}
    FROM marketplace_offer_pages AS offer
    ${sellerMatchSourceJoinSql("$1")}
    ${sellerOfferControlsJoinSql("$1")}
    LEFT JOIN marketplace_account_pages AS buyer
      ON buyer.account_id = offer.buyer_account_id
    LEFT JOIN marketplace_seller_listing_availability_pages AS availability
      ON availability.account_id = $1
    WHERE ${innerWhere.join("\n      AND ")}
      AND ${sellerOfferControlsWhereSql()}`;

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
         ${sellerMatchOrderSql()}
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
       ${sellerOfferSelectSql("$1")},
       ${sellerMatchSourceSelectSql}
     FROM marketplace_offer_pages AS offer
     ${sellerMatchSourceJoinSql("$1")}
     ${sellerOfferControlsJoinSql("$1")}
     LEFT JOIN marketplace_account_pages AS buyer
       ON buyer.account_id = offer.buyer_account_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = $1
     WHERE offer.offer_id = $2
       AND ${sellerMatchSourceWhereSql("$1")}
       AND ${sellerOfferControlsWhereSql()}`,
    [sellerAccountId, offerId],
  );

  const row = result.rows[0];

  return row ? mapOfferMatchRow(row) : null;
}

export async function getOfferMatchForListing(
  db: PgQueryable,
  offerId: string,
  sellerAccountId: string,
  listingId: string,
  { checkProjectedOffersAway = true }: { checkProjectedOffersAway?: boolean } = {},
): Promise<ListingOfferMatchRow | null> {
  const result = await db.query<OfferMatchPageRow>(
    `SELECT
       ${sellerOfferSelectSql("$1")}
     FROM marketplace_offer_pages AS offer
     ${sellerExactListingJoinSql("$1", "$3")}
     ${sellerOfferControlsJoinSql("$1")}
     LEFT JOIN marketplace_account_pages AS buyer
       ON buyer.account_id = offer.buyer_account_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = $1
     WHERE offer.offer_id = $2
       AND ${buyerVisibleOfferPredicateSql("offer", "buyer", checkProjectedOffersAway)}
       AND ${sellerVisibilitySql(checkProjectedOffersAway)}
       AND ${sellerOfferControlsWhereSql()}`,
    [sellerAccountId, offerId, listingId],
  );

  const row = result.rows[0];
  return row ? mapListingOfferMatchRow(row) : null;
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
       ${sellerOfferSelectSql("seller_account.seller_account_id")},
       ${sellerMatchSourceSelectSql}
     FROM seller_accounts AS seller_account
     INNER JOIN marketplace_offer_pages AS offer
       ON offer.offer_id = $1
     ${sellerMatchSourceJoinSql("seller_account.seller_account_id")}
     ${sellerOfferControlsJoinSql("seller_account.seller_account_id")}
     LEFT JOIN marketplace_account_pages AS buyer
       ON buyer.account_id = offer.buyer_account_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = seller_account.seller_account_id
     WHERE ${sellerMatchSourceWhereSql("seller_account.seller_account_id")}
       AND ${sellerOfferControlsWhereSql()}`,
    [offerId, uniqueSellerAccountIds],
  );

  return new Map(result.rows.map((row) => [row.seller_account_id, mapOfferMatchRow(row)]));
}
