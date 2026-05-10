import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  InventoryProductSchema,
} from "./versioning";
import { toInventoryItemProductSchema } from "./versioning";

export type InventoryCatalogItemSnapshot = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  product_schema: InventoryProductSchema | null;
  updated_at: string;
}>;

export type InventoryExternalProductReference = Readonly<{
  provider_key: string;
  external_key: string;
  catalog_item_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  updated_at: string;
}>;

type InventoryCatalogItemRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  product_schema: unknown;
  updated_at: string;
}>;

type InventoryExternalProductReferenceRow = Omit<
  InventoryExternalProductReference,
  "selected_options"
> & Readonly<{
  selected_options: unknown;
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
       language_code,
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

export async function getInventoryExternalProductReference(
  db: PgQueryable,
  providerKey: string,
  externalKey: string,
): Promise<InventoryExternalProductReference | null> {
  const result = await db.query<InventoryExternalProductReferenceRow>(
    `SELECT
       provider_key,
       external_key,
       catalog_item_id,
       selected_options,
       updated_at
     FROM inventory_catalog_external_product_references
     WHERE provider_key = $1
       AND external_key = $2`,
    [providerKey.trim().toLowerCase(), externalKey.trim().toLowerCase()],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as InventoryExternalProductReference["selected_options"])
      : [],
  };
}
