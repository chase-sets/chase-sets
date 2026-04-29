import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  InventoryProductSchema,
} from "./versioning";
import { toInventoryItemProductSchema } from "./versioning";

export type InventoryCatalogItemSnapshot = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  product_schema: InventoryProductSchema | null;
  updated_at: string;
}>;

type InventoryCatalogItemRow = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  product_schema: unknown;
  updated_at: string;
}>;

async function hasInventoryCatalogItemsTable(db: PgQueryable) {
  const result = await db.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.inventory_catalog_items') AS table_name`,
  );

  return Boolean(result.rows[0]?.table_name);
}

export async function getInventoryCatalogItem(
  db: PgQueryable,
  itemId: string,
): Promise<InventoryCatalogItemSnapshot | null> {
  if (!(await hasInventoryCatalogItemsTable(db))) {
    return null;
  }

  const result = await db.query<InventoryCatalogItemRow>(
    `SELECT
       catalog_item_id,
       title,
       subtitle,
       blueprint_id,
       status,
       product_schema,
       updated_at
     FROM inventory_catalog_items
     WHERE catalog_item_id = $1`,
    [itemId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...row,
    product_schema: toInventoryItemProductSchema(
      typeof row.product_schema === "object" && row.product_schema !== null
        ? (row.product_schema as InventoryProductSchema)
        : null,
    ),
  };
}
