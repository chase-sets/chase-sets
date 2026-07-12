import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type InventoryImportAccountSkuMapping = Readonly<{
  mapping_id: string;
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
    `SELECT mapping_id,
            account_id,
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

/**
 * Batch seller-SKU -> inventory-item resolution, reusing the native-SKU
 * mapping table this feature already owns (m71) rather than duplicating its
 * ambiguity/normalization rules. Built for m113 bulk reprice ingestion
 * (the m113 bulk reprice on-ramp), which resolves up to a chunk's worth of seller SKUs per call
 * instead of one row at a time -- two batched queries regardless of chunk
 * size, so throughput does not degrade with row count.
 *
 * A "mapped" seller SKU (exactly one account_sku_mapping row) can still miss
 * an inventory item -- the mapping records intent (this SKU means this
 * catalog item + variant) but the seller may not currently hold stock/an
 * item under it. That case reports "unmapped-item" distinctly from
 * "missing" (no mapping registered at all) so callers can give sellers an
 * accurate reason.
 */
export type InventoryAccountSellerSkuItemResolution =
  | Readonly<{ sellerSku: string; status: "missing" }>
  | Readonly<{ sellerSku: string; status: "ambiguous"; mappingCount: number }>
  | Readonly<{ sellerSku: string; status: "unmapped-item"; catalogItemId: string }>
  | Readonly<{
      sellerSku: string;
      status: "mapped";
      inventoryItemId: string;
      catalogItemId: string;
      productId: string;
    }>;

function accountSkuItemTargetKey(catalogItemId: string, selectedOptions: unknown): string {
  return `${catalogItemId}::${JSON.stringify(selectedOptions ?? [])}`;
}

export async function resolveAccountSellerSkusToInventoryItems(
  db: PgQueryable,
  params: Readonly<{ accountId: string; sellerSkus: readonly string[] }>,
): Promise<readonly InventoryAccountSellerSkuItemResolution[]> {
  const normalizedBySellerSku = new Map<string, string>();
  for (const sellerSku of params.sellerSkus) {
    normalizedBySellerSku.set(sellerSku, normalizeInventoryImportSellerSku(sellerSku));
  }
  const normalizedSkus = [...new Set([...normalizedBySellerSku.values()].filter((value) => value.length > 0))];

  const mappingsByNormalizedSku = new Map<string, RawInventoryImportAccountSkuMapping[]>();
  if (normalizedSkus.length > 0) {
    const mappingResult = await db.query<RawInventoryImportAccountSkuMapping>(
      `SELECT mapping_id,
              account_id,
              seller_sku,
              normalized_seller_sku,
              catalog_item_id,
              selected_options,
              updated_at
       FROM inventory_import_account_sku_mappings
       WHERE account_id = $1
         AND normalized_seller_sku = ANY($2::text[])
       ORDER BY updated_at DESC, seller_sku ASC, catalog_item_id ASC`,
      [params.accountId, normalizedSkus],
    );
    for (const row of mappingResult.rows) {
      const list = mappingsByNormalizedSku.get(row.normalized_seller_sku) ?? [];
      list.push(row);
      mappingsByNormalizedSku.set(row.normalized_seller_sku, list);
    }
  }

  const uniqueMappedTargets = new Map<string, { catalogItemId: string; selectedOptions: unknown }>();
  for (const rows of mappingsByNormalizedSku.values()) {
    if (rows.length === 1) {
      const mapping = normalizeMapping(rows[0]);
      uniqueMappedTargets.set(accountSkuItemTargetKey(mapping.catalog_item_id, mapping.selected_options), {
        catalogItemId: mapping.catalog_item_id,
        selectedOptions: mapping.selected_options,
      });
    }
  }

  const itemByTargetKey = new Map<string, { itemId: string; productId: string }>();
  if (uniqueMappedTargets.size > 0) {
    const catalogItemIds = [...new Set([...uniqueMappedTargets.values()].map((target) => target.catalogItemId))];
    const itemResult = await db.query<{
      item_id: string;
      catalog_catalog_item_id: string;
      product_id: string;
      selected_options: unknown;
    }>(
      `SELECT item_id, catalog_catalog_item_id, product_id, selected_options
       FROM inventory_items
       WHERE account_id = $1
         AND catalog_catalog_item_id = ANY($2::text[])`,
      [params.accountId, catalogItemIds],
    );
    for (const row of itemResult.rows) {
      itemByTargetKey.set(accountSkuItemTargetKey(row.catalog_catalog_item_id, row.selected_options), {
        itemId: row.item_id,
        productId: row.product_id,
      });
    }
  }

  return params.sellerSkus.map((sellerSku): InventoryAccountSellerSkuItemResolution => {
    const normalized = normalizedBySellerSku.get(sellerSku) ?? "";
    if (!normalized) {
      return { sellerSku, status: "missing" };
    }
    const mappings = mappingsByNormalizedSku.get(normalized) ?? [];
    if (mappings.length === 0) {
      return { sellerSku, status: "missing" };
    }
    if (mappings.length > 1) {
      return { sellerSku, status: "ambiguous", mappingCount: mappings.length };
    }
    const mapping = normalizeMapping(mappings[0]);
    const item = itemByTargetKey.get(accountSkuItemTargetKey(mapping.catalog_item_id, mapping.selected_options));
    if (!item) {
      return { sellerSku, status: "unmapped-item", catalogItemId: mapping.catalog_item_id };
    }
    return {
      sellerSku,
      status: "mapped",
      inventoryItemId: item.itemId,
      catalogItemId: mapping.catalog_item_id,
      productId: item.productId,
    };
  });
}
