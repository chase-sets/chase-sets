import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  findAncestorReferenceByTypeKey,
  loadReferenceRecordMap,
  setCodeFromReferenceAttributes,
  type ReferenceRecordRef,
} from "../../../support/item-support/reference-records";
import { searchDiscoveryItems, type DiscoverySearchItemRow } from "../../search/read-model/queries";

const SEARCH_REFERENCE_RECORDS_TABLE = "discovery_search_catalog_reference_records";

// Kept intentionally small: this is a curated first page for SEO/initial paint.
// A set with more cards links out to `/search?reference.<typeKey>=<id>` (the
// same reference filter this query applies) for the full, paginated result set.
export const BROWSE_SET_ITEM_GRID_LIMIT = 60;

// Mirrors `SET_LIKE_REFERENCE_TYPE_KEYS` in support/item-support/reference-records.ts
// as a literal SQL array — kept in sync by hand since it is small, stable
// domain vocabulary (see that module for the single source of truth).
const SET_LIKE_TYPE_KEYS_SQL_ARRAY = ["set", "expansion"] as const;

const PRODUCT_LINE_TYPE_KEY = "product-line";

export type DiscoveryBrowseSetPageRow = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  slug: string;
  name: string;
  code: string | null;
  game: string | null;
  release_date: string | null;
  status: string;
  item_count: number;
  items: readonly DiscoverySearchItemRow[];
  updated_at: string;
}>;

type ReferenceRecordPageRow = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  slug: string;
  name: string;
  attributes: unknown;
  status: string;
  updated_at: string;
}>;

export async function getDiscoveryBrowseSetPageBySlug(
  db: PgQueryable,
  slug: string,
): Promise<DiscoveryBrowseSetPageRow | null> {
  const result = await db.query<ReferenceRecordPageRow>(
    `SELECT
       record.reference_record_id,
       record.type_key,
       record.key,
       record.slug,
       record.name,
       record.attributes,
       record.status,
       record.updated_at::text AS updated_at
     FROM ${SEARCH_REFERENCE_RECORDS_TABLE} AS record
     LEFT JOIN discovery_slug_redirects AS redirect
       ON redirect.entity_kind = 'reference-record'
      AND redirect.slug = $1
     WHERE record.type_key = ANY($2::text[])
       AND (
         record.slug = $1
         OR record.reference_record_id = redirect.entity_id
         OR record.slug = redirect.target_slug
       )
     ORDER BY (record.slug = $1) DESC
     LIMIT 1`,
    [slug, [...SET_LIKE_TYPE_KEYS_SQL_ARRAY]],
  );

  const row = result.rows[0];
  if (!row || row.status !== "active") {
    return null;
  }

  const referenceMap = await loadReferenceRecordMap(db, SEARCH_REFERENCE_RECORDS_TABLE, [row.reference_record_id]);
  const reference = referenceMap.get(row.reference_record_id) ?? null;
  const game = reference ? gameNameForReference(reference) : null;
  const code = setCodeFromReferenceAttributes(row.attributes);
  const releaseDate = releaseDateFromAttributes(row.attributes);

  const searchResult = await searchDiscoveryItems(
    db,
    {
      status: "active",
      referenceFilters: [{ typeKey: row.type_key, referenceId: row.reference_record_id }],
      limit: BROWSE_SET_ITEM_GRID_LIMIT,
      includeTotal: true,
    },
    { loadFacets: false, loadMarketSummaries: true },
  );

  return {
    reference_record_id: row.reference_record_id,
    type_key: row.type_key,
    key: row.key,
    slug: row.slug,
    name: row.name,
    code,
    game,
    release_date: releaseDate,
    status: row.status,
    item_count: searchResult.total ?? searchResult.items.length,
    items: searchResult.items,
    updated_at: row.updated_at,
  };
}

function gameNameForReference(reference: ReferenceRecordRef): string | null {
  return findAncestorReferenceByTypeKey(reference, PRODUCT_LINE_TYPE_KEY)?.name ?? null;
}

function releaseDateFromAttributes(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return null;
  }

  const value = (attributes as Record<string, unknown>)["release-date"];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
