import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export const CART_SELLER_OPTIONS_PER_LINE_LIMIT = 25;

export type CheckoutCartLineRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string;
  item_subtitle: string | null;
  item_image_url: string | null;
  item_image_srcset: string | null;
  item_image_loading_url: string | null;
  item_image_loading_alt: string | null;
  item_image_loading_srcset: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  quantity: number;
  fulfillment_mode: "optimize" | "locked-listing";
  locked_listing_id: string | null;
  selected_listing_id: string | null;
  selected_listing_seller_account_id: string | null;
  selected_listing_seller_display_name: string | null;
  selected_listing_seller_slug: string | null;
  selected_listing_price_amount: string | null;
  selected_listing_snapshot_source: string | null;
  selected_listing_snapshot_captured_at: string | null;
  seller_preference_id: string | null;
  availability_state: "available" | "unavailable" | "changed" | "waiting-for-supply";
  seller_options: readonly CheckoutCartSellerOptionRow[];
  created_at: string;
  updated_at: string;
}>;

export type CheckoutCartSellerOptionRow = Readonly<{
  listing_id: string;
  seller_account_id: string | null;
  seller_slug: string | null;
  seller_display_name: string | null;
  seller_average_rating: string | null;
  seller_review_count: number;
  price_amount: string;
  available_quantity: number;
  product_summary: string | null;
  product_measure_snapshot: Readonly<Record<string, unknown>> | null;
}>;

type CartLinePageRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string;
  item_subtitle: string | null;
  item_image_url: string | null;
  item_image_srcset: string | null;
  item_image_loading_url: string | null;
  item_image_loading_alt: string | null;
  item_image_loading_srcset: string | null;
  selected_options: unknown;
  product_summary: string | null;
  quantity: number;
  fulfillment_mode: string;
  locked_listing_id: string | null;
  selected_listing_id: string | null;
  selected_listing_seller_account_id: string | null;
  selected_listing_seller_display_name: string | null;
  selected_listing_seller_slug: string | null;
  selected_listing_price_amount: string | null;
  selected_listing_snapshot_source: string | null;
  selected_listing_snapshot_captured_at: string | null;
  seller_preference_id: string | null;
  availability_state: string;
  seller_options: unknown;
  created_at: string;
  updated_at: string;
}>;

function mapSellerOption(value: unknown): CheckoutCartSellerOptionRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const listingId = String(source.listing_id ?? "").trim();
  const priceAmount = String(source.price_amount ?? "").trim();
  const availableQuantity = Number(source.available_quantity ?? 0);

  if (!listingId || !priceAmount || !Number.isFinite(availableQuantity) || availableQuantity <= 0) {
    return null;
  }

  return {
    listing_id: listingId,
    seller_account_id:
      source.seller_account_id === null || source.seller_account_id === undefined
        ? null
        : String(source.seller_account_id).trim() || null,
    seller_slug:
      source.seller_slug === null || source.seller_slug === undefined
        ? null
        : String(source.seller_slug).trim() || null,
    seller_display_name:
      source.seller_display_name === null || source.seller_display_name === undefined
        ? null
        : String(source.seller_display_name).trim() || null,
    seller_average_rating:
      source.seller_average_rating === null || source.seller_average_rating === undefined
        ? null
        : String(source.seller_average_rating).trim() || null,
    seller_review_count: Number.isFinite(Number(source.seller_review_count)) ? Number(source.seller_review_count) : 0,
    price_amount: priceAmount,
    available_quantity: availableQuantity,
    product_summary:
      source.product_summary === null || source.product_summary === undefined
        ? null
        : String(source.product_summary).trim() || null,
    product_measure_snapshot:
      typeof source.product_measure_snapshot === "object" && source.product_measure_snapshot !== null
        ? (source.product_measure_snapshot as Readonly<Record<string, unknown>>)
        : null,
  };
}

function mapNullableText(value: unknown) {
  return value === null || value === undefined ? null : String(value).trim() || null;
}

function mapCartLineRow(row: CartLinePageRow): CheckoutCartLineRow {
  return {
    ...row,
    fulfillment_mode: row.fulfillment_mode === "locked-listing" ? "locked-listing" : "optimize",
    availability_state:
      row.availability_state === "unavailable" ||
      row.availability_state === "changed" ||
      row.availability_state === "waiting-for-supply"
        ? row.availability_state
        : "available",
    selected_listing_id: mapNullableText(row.selected_listing_id),
    selected_listing_seller_account_id: mapNullableText(row.selected_listing_seller_account_id),
    selected_listing_seller_display_name: mapNullableText(row.selected_listing_seller_display_name),
    selected_listing_seller_slug: mapNullableText(row.selected_listing_seller_slug),
    selected_listing_price_amount: mapNullableText(row.selected_listing_price_amount),
    selected_listing_snapshot_source: mapNullableText(row.selected_listing_snapshot_source),
    selected_listing_snapshot_captured_at: mapNullableText(row.selected_listing_snapshot_captured_at),
    selected_options: Array.isArray(row.selected_options) ? (row.selected_options as VersionSelectedOptionEntry[]) : [],
    seller_options: Array.isArray(row.seller_options)
      ? row.seller_options
          .map(mapSellerOption)
          .filter((option): option is CheckoutCartSellerOptionRow => option !== null)
      : [],
  };
}

export async function listCartLines(db: PgQueryable, buyerAccountId: string): Promise<CheckoutCartLineRow[]> {
  const result = await db.query<CartLinePageRow>(
    `SELECT
       line.buyer_account_id,
       line.line_id,
       line.catalog_catalog_item_id,
       line.product_id,
       line.item_language_code,
       line.item_title,
       line.item_subtitle,
       line.item_image_url,
       line.item_image_srcset,
       line.item_image_loading_url,
       line.item_image_loading_alt,
       line.item_image_loading_srcset,
       line.selected_options,
       line.product_summary,
       line.quantity,
       line.fulfillment_mode,
       line.locked_listing_id,
       line.selected_listing_id,
       line.selected_listing_seller_account_id,
       line.selected_listing_seller_display_name,
       line.selected_listing_seller_slug,
       line.selected_listing_price_amount::text AS selected_listing_price_amount,
       line.selected_listing_snapshot_source,
       line.selected_listing_snapshot_captured_at::text AS selected_listing_snapshot_captured_at,
       line.seller_preference_id,
       line.availability_state,
       opt.seller_options,
       line.created_at,
       line.updated_at
     FROM checkout_cart_line_pages line
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         json_agg(
           json_build_object(
             'listing_id', o.listing_id,
             'seller_account_id', o.seller_account_id,
             'seller_slug', COALESCE(seller.slug, o.seller_slug),
             'seller_display_name', COALESCE(seller.display_name, o.seller_display_name),
             'seller_average_rating', COALESCE(seller.average_rating, o.seller_average_rating)::text,
             'seller_review_count', COALESCE(seller.review_count, o.seller_review_count, 0),
             'price_amount', o.price_amount::text,
             'available_quantity', LEAST(
               o.listing_quantity_cap,
               GREATEST(
                 COALESCE(o.supply_total_quantity, o.listing_quantity_cap) - COALESCE(o.active_held_quantity, 0),
                 0
               )
             ),
             'product_summary', o.product_summary,
             'product_measure_snapshot', o.product_measure_snapshot
           )
           ORDER BY o.price_amount ASC, o.listing_id ASC
         ),
         '[]'::json
       ) AS seller_options
       FROM (
         SELECT
           option.listing_id,
           option.seller_account_id,
           option.seller_slug,
           option.seller_display_name,
           option.seller_average_rating,
           option.seller_review_count,
           option.price_amount,
           option.listing_quantity_cap,
           option.supply_total_quantity,
           option.active_held_quantity,
           option.product_summary,
           option.product_measure_snapshot
         FROM checkout_marketplace_seller_options option
         WHERE option.product_id = line.product_id
           AND option.status = 'active'
           -- At-capacity sellers (m127 #4883) drop out of both the
           -- alternative-listing candidates and, for a locked line, the
           -- readiness re-check (selectedCartReadinessListing looks the
           -- locked listing_id up in this same result set).
           AND option.at_capacity = false
           AND LEAST(
             option.listing_quantity_cap,
             GREATEST(
               COALESCE(option.supply_total_quantity, option.listing_quantity_cap) -
                 COALESCE(option.active_held_quantity, 0),
               0
             )
           ) > 0
         ORDER BY option.price_amount ASC, option.listing_id ASC
         LIMIT $2
       ) o
       LEFT JOIN checkout_seller_accounts seller
         ON seller.account_id = o.seller_account_id
     ) opt ON true
     WHERE line.buyer_account_id = $1
     ORDER BY line.updated_at DESC, line.line_id ASC`,
    [buyerAccountId, CART_SELLER_OPTIONS_PER_LINE_LIMIT],
  );

  return result.rows.map(mapCartLineRow);
}
