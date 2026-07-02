import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type InventoryImportAccountSkuMapping = Readonly<{
  account_id: string;
  seller_sku: string;
  normalized_seller_sku: string;
  catalog_item_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  updated_at: string;
}>;

export type InventoryImportAccountSkuResolution =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ambiguous"; mappings: readonly InventoryImportAccountSkuMapping[] }>
  | Readonly<{ status: "mapped"; mapping: InventoryImportAccountSkuMapping }>;

export function normalizeInventoryImportSellerSku(value: string): string {
  return value.trim().toLowerCase();
}

type RawInventoryImportAccountSkuMapping = Omit<InventoryImportAccountSkuMapping, "selected_options"> &
  Readonly<{ selected_options: unknown }>;

function normalizeMapping(row: RawInventoryImportAccountSkuMapping): InventoryImportAccountSkuMapping {
  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as InventoryImportAccountSkuMapping["selected_options"])
      : [],
  };
}

export async function resolveInventoryImportAccountSkuMapping(
  db: PgQueryable,
  params: Readonly<{ accountId: string; sellerSku: string }>,
): Promise<InventoryImportAccountSkuResolution> {
  const normalizedSellerSku = normalizeInventoryImportSellerSku(params.sellerSku);
  if (!normalizedSellerSku) {
    return { status: "missing" };
  }

  const result = await db.query<RawInventoryImportAccountSkuMapping>(
    `SELECT account_id,
            seller_sku,
            normalized_seller_sku,
            catalog_item_id,
            selected_options,
            updated_at
     FROM inventory_import_account_sku_mappings
     WHERE account_id = $1
       AND normalized_seller_sku = $2
     ORDER BY updated_at DESC, seller_sku ASC, catalog_item_id ASC`,
    [params.accountId, normalizedSellerSku],
  );
  const mappings = result.rows.map(normalizeMapping);

  if (mappings.length === 0) {
    return { status: "missing" };
  }
  if (mappings.length > 1) {
    return { status: "ambiguous", mappings };
  }

  return { status: "mapped", mapping: mappings[0] };
}
