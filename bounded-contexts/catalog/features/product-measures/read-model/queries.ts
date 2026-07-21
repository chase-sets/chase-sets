import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";
import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";

export type CatalogProductMeasureProfileRow = Readonly<{
  profile_id: string;
  key: string;
  name: string;
  status: string;
  match_blueprint_id: string | null;
  match_category_ids: readonly string[];
  match_selected_options: readonly { dimensionId: string; optionId: string }[];
  measure_snapshot: ProductMeasureSnapshot;
  precedence: number;
  updated_at: string;
}>;

export type CatalogResolvedProductMeasureRow = Readonly<{
  product_id: string;
  catalog_item_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  measure_snapshot: ProductMeasureSnapshot | null;
  missing_reason: string | null;
  updated_at: string;
}>;

export async function listProductMeasureProfiles(db: PgQueryable) {
  const result = await db.query<{
    profile_id: string;
    key: string;
    name: string;
    status: string;
    match_blueprint_id: string | null;
    match_category_ids: unknown;
    match_selected_options: unknown;
    measure_snapshot: unknown;
    precedence: number;
    updated_at: string;
  }>(
    catalogIsoUtcListSql(
      `SELECT *
     FROM catalog_product_measure_profiles
     ORDER BY precedence ASC, key ASC`,
      "updated_at",
    ),
  );

  return result.rows.map((row) => ({
    ...row,
    match_category_ids: Array.isArray(row.match_category_ids) ? row.match_category_ids.map(String) : [],
    match_selected_options: selectedOptionsFromUnknown(row.match_selected_options),
    measure_snapshot: row.measure_snapshot as ProductMeasureSnapshot,
  }));
}

export async function listResolvedProductMeasures(db: PgQueryable, catalogItemId?: string | null) {
  const values: string[] = [];
  const where = catalogItemId ? "WHERE catalog_item_id = $1" : "";
  if (catalogItemId) {
    values.push(catalogItemId);
  }
  const result = await db.query<{
    product_id: string;
    catalog_item_id: string;
    selected_options: unknown;
    measure_snapshot: unknown;
    missing_reason: string | null;
    updated_at: string;
  }>(
    catalogIsoUtcListSql(
      `SELECT *
     FROM catalog_resolved_product_measures
     ${where}
     ORDER BY catalog_item_id ASC, product_id ASC`,
      "updated_at",
    ),
    values,
  );

  return result.rows.map((row) => ({
    ...row,
    selected_options: selectedOptionsFromUnknown(row.selected_options),
    measure_snapshot:
      typeof row.measure_snapshot === "object" && row.measure_snapshot !== null
        ? (row.measure_snapshot as ProductMeasureSnapshot)
        : null,
  }));
}

function selectedOptionsFromUnknown(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return null;
          }
          const candidate = entry as { dimensionId?: unknown; optionId?: unknown };
          return typeof candidate.dimensionId === "string" && typeof candidate.optionId === "string"
            ? { dimensionId: candidate.dimensionId, optionId: candidate.optionId }
            : null;
        })
        .filter((entry): entry is { dimensionId: string; optionId: string } => entry !== null)
    : [];
}
