import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export type CheckoutSellListLineRow = Readonly<{
  seller_account_id: string;
  line_id: string;
  line_type: "selected-offer" | "product";
  offer_id: string | null;
  buyer_account_id: string | null;
  buyer_display_name: string | null;
  offer_price_amount: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  quantity: number;
  fallback_mode: "none" | "create-listing";
  minimum_listing_price_amount: string | null;
  created_at: string;
  updated_at: string;
}>;

type SellListPageRow = Omit<CheckoutSellListLineRow, "selected_options" | "line_type" | "fallback_mode"> & {
  selected_options: unknown;
  line_type: string;
  fallback_mode: string;
};

function mapSellListLine(row: SellListPageRow): CheckoutSellListLineRow {
  return {
    ...row,
    line_type: row.line_type === "selected-offer" ? "selected-offer" : "product",
    fallback_mode: row.fallback_mode === "create-listing" ? "create-listing" : "none",
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as VersionSelectedOptionEntry[])
      : [],
  };
}

export async function listSellListLines(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<CheckoutSellListLineRow[]> {
  const result = await db.query<SellListPageRow>(
    `SELECT
       seller_account_id,
       line_id,
       line_type,
       offer_id,
       buyer_account_id,
       buyer_display_name,
       offer_price_amount,
       catalog_catalog_item_id,
       product_id,
       item_title,
       item_subtitle,
       selected_options,
       product_summary,
       quantity,
       fallback_mode,
       minimum_listing_price_amount,
       created_at,
       updated_at
     FROM checkout_sell_list_line_pages
     WHERE seller_account_id = $1
     ORDER BY updated_at DESC, line_id ASC`,
    [sellerAccountId],
  );

  return result.rows.map(mapSellListLine);
}
