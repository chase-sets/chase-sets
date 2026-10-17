import type { CatalogProductLineReference } from "@chase-sets/catalog-product-line";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PricingCatalogItemProductLineInput = Readonly<{
  catalogItemId: string;
  productLine: CatalogProductLineReference | null;
}>;

type ProductLineInputRow = Readonly<{
  catalog_item_id: string;
}> &
  (
    | Readonly<{ product_line_reference_id: null; product_line_name: null; product_line_version: number | null }>
    | Readonly<{ product_line_reference_id: string; product_line_name: string; product_line_version: number }>
  );

export async function readCatalogItemProductLineInputs(
  db: PgQueryable,
  catalogItemIds: readonly string[],
): Promise<readonly PricingCatalogItemProductLineInput[]> {
  if (catalogItemIds.length === 0) return [];
  const result = await db.query<ProductLineInputRow>(
    `SELECT catalog_item_id, product_line_reference_id, product_line_name, product_line_version
     FROM pricing_catalog_item_inputs
     WHERE catalog_item_id = ANY($1::text[])
     ORDER BY catalog_item_id`,
    [catalogItemIds],
  );
  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    productLine:
      row.product_line_reference_id === null
        ? null
        : {
            referenceId: row.product_line_reference_id,
            name: row.product_line_name,
            version: row.product_line_version,
          },
  }));
}
