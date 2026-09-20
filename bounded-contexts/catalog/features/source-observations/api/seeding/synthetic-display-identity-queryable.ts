import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogPromotionCurrentItem } from "../promotion/promotion-display-identity";

/**
 * SYNTHETIC, TEST-ONLY display identity data. This queryable answers exactly
 * the read-model queries the Catalog Item display identity resolver (and the
 * promotion planners' current-item load) issue, from in-memory fixtures with
 * unmistakably synthetic identities. It is never evidence of production
 * identity validation: database-free seed and unit evidence uses it so the
 * validated planner entry still runs the real resolver, while PostgreSQL
 * proofs run against the projected read model.
 */

export type SyntheticDisplayTemplate = Readonly<{
  key: string;
  target_kind: "global" | "blueprint" | "category" | "reference-record" | "catalog-item";
  target_id: string | null;
  priority: number;
  title_template: string;
  subtitle_template: string | null;
  required_field_keys: readonly string[];
}>;

export type SyntheticReferenceRecord = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  name: string;
  attributes: Readonly<Record<string, unknown>>;
  relationships: readonly Readonly<{ relationshipType: string; referenceId: string }>[];
  status: string;
}>;

export type SyntheticDisplayIdentityFixture = Readonly<{
  fields?: readonly Readonly<{ field_id: string; key: string }>[];
  templates?: readonly SyntheticDisplayTemplate[];
  referenceRecords?: readonly SyntheticReferenceRecord[];
  currentItems?: readonly CatalogPromotionCurrentItem[];
  /** Receives every query this fixture does not own. */
  fallback?: PgQueryable;
}>;

/** A global template that resolves any item with a non-empty native title. */
export const syntheticResolvedDisplayTemplate: SyntheticDisplayTemplate = {
  key: "synthetic-global-title",
  target_kind: "global",
  target_id: null,
  priority: 0,
  title_template: "{item.title}",
  subtitle_template: null,
  required_field_keys: [],
};

export type SyntheticDisplayIdentityQueryable = PgQueryable & Readonly<{ queries: readonly string[] }>;

export function createSyntheticDisplayIdentityQueryable(
  fixture: SyntheticDisplayIdentityFixture = {},
): SyntheticDisplayIdentityQueryable {
  const queries: string[] = [];
  const fields = fixture.fields ?? [];
  const templates = fixture.templates ?? [syntheticResolvedDisplayTemplate];
  const referenceRecords = fixture.referenceRecords ?? [];
  const currentItems = fixture.currentItems ?? [];

  const query = async <T>(sql: string, values: readonly unknown[] = []) => {
    queries.push(sql);
    const ids = (index: number) => (Array.isArray(values[index]) ? (values[index] as readonly string[]) : []);

    if (sql.includes("FROM catalog_fields") && sql.includes("field_id = ANY($1)")) {
      const rows = fields.filter((field) => ids(0).includes(field.field_id));
      return { rowCount: rows.length, rows: rows as T[] };
    }
    if (sql.includes("FROM catalog_display_templates")) {
      const rows = [...templates].sort(
        (left, right) => right.priority - left.priority || left.key.localeCompare(right.key),
      );
      return { rowCount: rows.length, rows: rows as T[] };
    }
    if (sql.includes("FROM catalog_reference_records") && sql.includes("reference_record_id = ANY($1)")) {
      const rows = referenceRecords.filter((record) => ids(0).includes(record.reference_record_id));
      return { rowCount: rows.length, rows: rows as T[] };
    }
    if (sql.includes("FROM catalog_item_aliases") || sql.includes("FROM catalog_reference_record_aliases")) {
      return { rowCount: 0, rows: [] as T[] };
    }
    if (sql.includes("FROM catalog_items") && sql.includes("category_ids") && sql.includes("catalog_item_id = $1")) {
      const rows = currentItems.filter((item) => item.catalog_item_id === values[0]);
      return { rowCount: rows.length, rows: rows as T[] };
    }
    if (fixture.fallback) {
      return fixture.fallback.query<T>(sql, values);
    }
    return { rowCount: 0, rows: [] as T[] };
  };

  return { query, queries } as SyntheticDisplayIdentityQueryable;
}

/** A synthetic draft Catalog Item row for refresh/link-existing fixtures. */
export function syntheticCurrentCatalogItem(
  overrides: Partial<CatalogPromotionCurrentItem> & Pick<CatalogPromotionCurrentItem, "catalog_item_id">,
): CatalogPromotionCurrentItem {
  return {
    language_code: "en",
    status: "draft",
    title: "synthetic-current-title",
    subtitle: null,
    blueprint_id: null,
    field_values: [],
    category_ids: [],
    ...overrides,
  };
}
