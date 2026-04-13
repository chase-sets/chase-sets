import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  InventoryVersionSchema,
} from "./versioning";
import { toInventoryRecordVersionSchema } from "./versioning";

export type InventoryCatalogItemSnapshot = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  version_schema: InventoryVersionSchema | null;
  updated_at: string;
}>;

type InventoryCatalogItemRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  version_schema: unknown;
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
       item_id,
       title,
       subtitle,
       blueprint_id,
       status,
       version_schema,
       updated_at
     FROM inventory_catalog_items
     WHERE item_id = $1`,
    [itemId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...row,
    version_schema: toInventoryRecordVersionSchema(
      typeof row.version_schema === "object" && row.version_schema !== null
        ? (row.version_schema as InventoryVersionSchema)
        : null,
    ),
  };
}
