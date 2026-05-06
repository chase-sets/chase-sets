import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export type CheckoutCartLineRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  item_image_url: string | null;
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
  item_image_url: string | null;
  selected_options: unknown;
  product_summary: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}>;

function mapCartLineRow(row: CartLinePageRow): CheckoutCartLineRow {
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
): Promise<CheckoutCartLineRow[]> {
  const result = await db.query<CartLinePageRow>(
    `SELECT
       line.buyer_account_id,
       line.line_id,
       line.catalog_catalog_item_id,
       line.product_id,
       line.item_title,
       line.item_subtitle,
       item_page.image_urls->>0 AS item_image_url,
       line.selected_options,
       line.product_summary,
       line.quantity,
       line.created_at,
       line.updated_at
     FROM checkout_cart_line_pages line
     LEFT JOIN discovery_item_detail_pages item_page
       ON item_page.catalog_item_id = line.catalog_catalog_item_id
     WHERE line.buyer_account_id = $1
     ORDER BY line.updated_at DESC, line.line_id ASC`,
    [buyerAccountId],
  );

  return result.rows.map(mapCartLineRow);
}
