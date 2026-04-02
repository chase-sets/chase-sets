import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectionEntry } from "../common";

export type OrderingCartLineRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string;
  item_subtitle: string | null;
  version_selection: readonly VersionSelectionEntry[];
  version_summary: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}>;

type CartLinePageRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string;
  item_subtitle: string | null;
  version_selection: unknown;
  version_summary: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}>;

function mapCartLineRow(row: CartLinePageRow): OrderingCartLineRow {
  return {
    ...row,
    version_selection: Array.isArray(row.version_selection)
      ? (row.version_selection as VersionSelectionEntry[])
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
       catalog_item_id,
       catalog_version_key,
       item_title,
       item_subtitle,
       version_selection,
       version_summary,
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
