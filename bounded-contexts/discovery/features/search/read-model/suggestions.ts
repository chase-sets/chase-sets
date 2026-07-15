import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { DiscoverySearchSuggestion } from "../../../support/client-support/contracts";
import { buildSimpleSearchQuery } from "../domain/normalization";

export const DISCOVERY_SEARCH_SUGGESTION_LIMIT = 8;

type DiscoverySearchSuggestionRow = Readonly<{
  catalog_item_id: string;
  title: string;
  slug: string;
  category: string | null;
}>;

export async function suggestDiscoveryItems(
  db: PgQueryable,
  query: string,
  requestedLimit = DISCOVERY_SEARCH_SUGGESTION_LIMIT,
): Promise<DiscoverySearchSuggestion[]> {
  const prefixQuery = buildSuggestionPrefixQuery(query);
  if (!prefixQuery) {
    return [];
  }

  const limit = clampSuggestionLimit(requestedLimit);
  const result = await db.query<DiscoverySearchSuggestionRow>(
    `SELECT catalog_item_id, title, slug,
            CASE WHEN jsonb_array_length(category_names) > 0 THEN category_names ->> 0 ELSE NULL END AS category
       FROM discovery_search_items
      WHERE status = $1
        AND search_text_simple @@ to_tsquery('simple', $2)
      ORDER BY ts_rank(search_text_simple, to_tsquery('simple', $2)) DESC,
               title ASC,
               catalog_item_id ASC
      LIMIT $3`,
    ["active", prefixQuery, limit],
  );

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    title: row.title,
    slug: row.slug,
    category: row.category,
  }));
}

function buildSuggestionPrefixQuery(value: string): string {
  const tokens = buildSimpleSearchQuery(value).split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }

  return tokens.map((token, index) => `${token}${index === tokens.length - 1 ? ":*" : ""}`).join(" & ");
}

function clampSuggestionLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DISCOVERY_SEARCH_SUGGESTION_LIMIT;
  }

  return Math.max(1, Math.min(Math.trunc(value), DISCOVERY_SEARCH_SUGGESTION_LIMIT));
}
