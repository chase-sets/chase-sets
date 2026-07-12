import { escapeLikePattern, type PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeGtin } from "@chase-sets/primitives/gtin";
import type { InventoryProductSchema } from "./versioning";
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

export type InventoryCatalogItemSearchParams = Readonly<{
  search?: string | null;
  status?: string | null;
  limit?: number | null;
}>;

export type InventoryExternalProductReference = Readonly<{
  provider_key: string;
  external_key: string;
  catalog_item_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  updated_at: string;
}>;

export type InventoryExternalCatalogItemReference = Readonly<{
  provider_key: string;
  external_key: string;
  catalog_item_id: string;
  updated_at: string;
}>;

export type InventoryCatalogItemGtinLookup = Readonly<{
  gtin: string;
  catalog_item_id: string;
  product_form: string | null;
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

type InventoryExternalProductReferenceRow = Omit<InventoryExternalProductReference, "selected_options"> &
  Readonly<{
    selected_options: unknown;
  }>;

async function hasInventoryCatalogItemsTable(db: PgQueryable) {
  const result = await db.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.inventory_catalog_items') AS table_name`,
  );

  return Boolean(result.rows[0]?.table_name);
}

function toInventoryCatalogItemSnapshot(row: InventoryCatalogItemRow): InventoryCatalogItemSnapshot {
  return {
    ...row,
    product_schema: toInventoryItemProductSchema(
      typeof row.product_schema === "object" && row.product_schema !== null
        ? (row.product_schema as InventoryProductSchema)
        : null,
    ),
  };
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

  return toInventoryCatalogItemSnapshot(row);
}

export async function searchInventoryCatalogItems(
  db: PgQueryable,
  params: InventoryCatalogItemSearchParams,
): Promise<{ items: InventoryCatalogItemSnapshot[]; total: number }> {
  if (!(await hasInventoryCatalogItemsTable(db))) {
    return { items: [], total: 0 };
  }

  const search = params.search?.trim() ?? "";
  const status = params.status?.trim() || "active";
  const limit = Math.max(1, Math.min(params.limit ?? 10, 25));
  const values: unknown[] = [status];
  const where = ["status = $1"];

  if (search.length > 0) {
    values.push(`%${escapeLikePattern(search)}%`);
    where.push(
      `(title ILIKE $${values.length} ESCAPE '\\' OR subtitle ILIKE $${values.length} ESCAPE '\\' OR catalog_item_id ILIKE $${values.length} ESCAPE '\\')`,
    );
  }

  values.push(limit);

  const result = await db.query<InventoryCatalogItemRow & { total_count: string }>(
    `SELECT
       catalog_item_id,
       language_code,
       title,
       subtitle,
       blueprint_id,
       status,
       product_schema,
       updated_at,
       COUNT(*) OVER() AS total_count
     FROM inventory_catalog_items
     WHERE ${where.join(" AND ")}
     ORDER BY
       CASE
         WHEN catalog_item_id ILIKE ${search.length > 0 ? `$2 ESCAPE '\\'` : "''"} THEN 0
         WHEN title ILIKE ${search.length > 0 ? `$2 ESCAPE '\\'` : "''"} THEN 1
         ELSE 2
       END,
       title ASC,
       subtitle ASC NULLS LAST,
       catalog_item_id ASC
     LIMIT $${values.length}`,
    values,
  );

  return {
    items: result.rows.map(toInventoryCatalogItemSnapshot),
    total: Number(result.rows[0]?.total_count ?? 0),
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

/**
 * Resolves a scanned barcode to the mirrored Catalog Item, using the same
 * `catalog.catalog-item.gtin-linked` facts Catalog projects into its own
 * `catalog_item_gtins` read model. Normalizes the input to canonical
 * GTIN-14 form before lookup (see `@chase-sets/primitives/gtin`).
 */
export async function getInventoryCatalogItemByGtin(
  db: PgQueryable,
  gtin: string,
): Promise<InventoryCatalogItemGtinLookup | null> {
  const normalized = normalizeGtin(gtin);
  if (!normalized) {
    return null;
  }

  const result = await db.query<InventoryCatalogItemGtinLookup>(
    `SELECT gtin, catalog_item_id, product_form, updated_at
     FROM inventory_catalog_gtins
     WHERE gtin = $1`,
    [normalized],
  );

  return result.rows[0] ?? null;
}

export async function getInventoryExternalCatalogItemReference(
  db: PgQueryable,
  providerKey: string,
  externalKey: string,
): Promise<InventoryExternalCatalogItemReference | null> {
  const result = await db.query<InventoryExternalCatalogItemReference>(
    `SELECT
       provider_key,
       external_key,
       catalog_item_id,
       updated_at
     FROM inventory_catalog_external_catalog_item_references
     WHERE provider_key = $1
       AND external_key = $2`,
    [providerKey.trim().toLowerCase(), externalKey.trim().toLowerCase()],
  );

  return result.rows[0] ?? null;
}
