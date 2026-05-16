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
  item_image_loading_url: string | null;
  item_image_loading_alt: string | null;
  item_image_loading_srcset: string | null;
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
  item_image_loading_url: string | null;
  item_image_loading_alt: string | null;
  item_image_loading_srcset: string | null;
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
       line.item_image_url,
       line.item_image_loading_url,
       line.item_image_loading_alt,
       line.item_image_loading_srcset,
       line.selected_options,
       line.product_summary,
       line.quantity,
       line.fulfillment_mode,
       line.locked_listing_id,
       line.seller_preference_id,
       line.availability_state,
       '[]'::jsonb AS seller_options,
       line.created_at,
       line.updated_at
     FROM checkout_cart_line_pages line
     WHERE line.buyer_account_id = $1
     ORDER BY line.updated_at DESC, line.line_id ASC`,
    [buyerAccountId],
  );

  return result.rows.map(mapCartLineRow);
}
