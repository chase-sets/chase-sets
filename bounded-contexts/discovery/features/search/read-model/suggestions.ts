import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { DiscoverySearchSuggestion } from "../../../support/client-support/contracts";
import { truncateDiscoverySearchSuggestionQuery } from "../domain/normalization";
import { buildSearchSynonymQueries } from "../domain/search-synonyms";
import { lookupServedSearchSetCodes } from "./queries";

export const DISCOVERY_SEARCH_SUGGESTION_LIMIT = 8;

type DiscoverySearchSuggestionRow = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  slug: string;
  category: string | null;
}>;

export async function suggestDiscoveryItems(
  db: PgQueryable,
  query: string,
  requestedLimit = DISCOVERY_SEARCH_SUGGESTION_LIMIT,
): Promise<DiscoverySearchSuggestion[]> {
  const queries = await buildSearchSynonymQueries(
    truncateDiscoverySearchSuggestionQuery(query),
    (codes) => lookupServedSearchSetCodes(db, codes),
    true,
  );
  if (!queries.simple) {
    return [];
  }

  const limit = clampSuggestionLimit(requestedLimit);
  const result = await db.query<DiscoverySearchSuggestionRow>(
    `SELECT catalog_item_id, title, subtitle, slug,
            CASE WHEN jsonb_array_length(category_names) > 0 THEN category_names ->> 0 ELSE NULL END AS category
       FROM discovery_search_items
      WHERE status = $1
        AND (search_text @@ to_tsquery('english', $2) OR search_text_simple @@ to_tsquery('simple', $3))
      ORDER BY (ts_rank(search_text, to_tsquery('english', $2)) + ts_rank(search_text_simple, to_tsquery('simple', $3))) DESC,
               title ASC,
               catalog_item_id ASC
      LIMIT $4`,
    ["active", queries.english, queries.simple, limit],
  );

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    title: row.title,
    subtitle: row.subtitle,
    slug: row.slug,
    category: row.category,
  }));
}

function clampSuggestionLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DISCOVERY_SEARCH_SUGGESTION_LIMIT;
  }

  return Math.max(1, Math.min(Math.trunc(value), DISCOVERY_SEARCH_SUGGESTION_LIMIT));
}
