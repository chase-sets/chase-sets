import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export type OrderingCartLineRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}>;

type CartLinePageRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}>;

function mapCartLineRow(row: CartLinePageRow): OrderingCartLineRow {
  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as VersionSelectedOptionEntry[])
      : [],
  };
}

export async function listCartLines(
  db: PgQueryable,
  buyerAccountId: string,
): Promise<OrderingCartLineRow[]> {
  const result = await db.query<CartLinePageRow>(
    `SELECT
       buyer_account_id,
       line_id,
       catalog_catalog_item_id,
       product_id,
       item_title,
       item_subtitle,
       selected_options,
       product_summary,
       quantity,
       created_at,
       updated_at
     FROM ordering_cart_line_pages
     WHERE buyer_account_id = $1
     ORDER BY updated_at DESC, line_id ASC`,
    [buyerAccountId],
  );

  return result.rows.map(mapCartLineRow);
}
