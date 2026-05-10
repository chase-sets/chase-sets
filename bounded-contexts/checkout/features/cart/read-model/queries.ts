import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export type CheckoutCartLineRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string;
  item_subtitle: string | null;
  item_image_url: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  quantity: number;
  fulfillment_mode: "optimize" | "locked-listing";
  locked_listing_id: string | null;
  seller_preference_id: string | null;
  availability_state: "available" | "unavailable" | "changed" | "waiting-for-supply";
  seller_options: readonly CheckoutCartSellerOptionRow[];
  created_at: string;
  updated_at: string;
}>;

export type CheckoutCartSellerOptionRow = Readonly<{
  listing_id: string;
  seller_display_name: string | null;
  price_amount: string;
  available_quantity: number;
  product_summary: string | null;
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
  selected_options: unknown;
  product_summary: string | null;
  quantity: number;
  fulfillment_mode: string;
  locked_listing_id: string | null;
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
    seller_display_name:
      source.seller_display_name === null || source.seller_display_name === undefined
        ? null
        : String(source.seller_display_name).trim() || null,
    price_amount: priceAmount,
    available_quantity: availableQuantity,
    product_summary:
      source.product_summary === null || source.product_summary === undefined
        ? null
        : String(source.product_summary).trim() || null,
  };
}

function mapCartLineRow(row: CartLinePageRow): CheckoutCartLineRow {
  return {
    ...row,
    fulfillment_mode:
      row.fulfillment_mode === "locked-listing" ? "locked-listing" : "optimize",
    availability_state:
      row.availability_state === "unavailable" ||
      row.availability_state === "changed" ||
      row.availability_state === "waiting-for-supply"
        ? row.availability_state
        : "available",
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as VersionSelectedOptionEntry[])
      : [],
    seller_options: Array.isArray(row.seller_options)
      ? row.seller_options
          .map(mapSellerOption)
          .filter((option): option is CheckoutCartSellerOptionRow => option !== null)
      : [],
  };
}

export async function listCartLines(
  db: PgQueryable,
  buyerAccountId: string,
): Promise<CheckoutCartLineRow[]> {
  const result = await db.query<CartLinePageRow>(
    `SELECT
       line.buyer_account_id,
       line.line_id,
       line.catalog_catalog_item_id,
       line.product_id,
       line.item_language_code,
       line.item_title,
       line.item_subtitle,
       item_page.image_urls->>0 AS item_image_url,
       line.selected_options,
       line.product_summary,
       line.quantity,
       line.fulfillment_mode,
       line.locked_listing_id,
       line.seller_preference_id,
       line.availability_state,
       COALESCE(seller_options.options, '[]'::jsonb) AS seller_options,
       line.created_at,
       line.updated_at
     FROM checkout_cart_line_pages line
     LEFT JOIN discovery_item_detail_pages item_page
       ON item_page.catalog_item_id = line.catalog_catalog_item_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'listing_id', option.listing_id,
           'seller_display_name', option.seller_display_name,
           'price_amount', option.price_amount,
           'available_quantity', option.available_quantity,
           'product_summary', option.product_summary
         )
         ORDER BY option.price_sort ASC, option.updated_at ASC, option.listing_id ASC
       ) AS options
       FROM (
         SELECT
           listing.listing_id,
           seller.display_name AS seller_display_name,
           listing.price_amount::text AS price_amount,
           listing.price_amount AS price_sort,
           listing.product_summary,
           listing.updated_at,
           LEAST(
             listing.quantity_cap,
             GREATEST(
               item.total_quantity - COALESCE(active_holds.held_quantity, 0),
               0
             )
           ) AS available_quantity
         FROM ordering_market_listing_inputs AS listing
         INNER JOIN ordering_inventory_item_inputs AS item
           ON item.item_id = listing.inventory_item_id
         LEFT JOIN ordering_account_pages AS seller
           ON seller.account_id = listing.seller_account_id
         LEFT JOIN (
           SELECT item_id, SUM(quantity)::integer AS held_quantity
           FROM ordering_inventory_hold_inputs
           WHERE status = 'active'
           GROUP BY item_id
         ) AS active_holds
           ON active_holds.item_id = item.item_id
         WHERE listing.status = 'active'
           AND listing.product_id = line.product_id
       ) AS option
       WHERE option.available_quantity > 0
     ) AS seller_options ON true
     WHERE line.buyer_account_id = $1
     ORDER BY line.updated_at DESC, line.line_id ASC`,
    [buyerAccountId],
  );

  return result.rows.map(mapCartLineRow);
}
