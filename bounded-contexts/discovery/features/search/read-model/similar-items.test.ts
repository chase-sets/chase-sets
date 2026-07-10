import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { DISCOVERY_SIMILAR_ITEMS_CATEGORY_BONUS, findSimilarDiscoveryItems } from "./similar-items";

type QueryCall = { sql: string; values: readonly unknown[] };

describe("findSimilarDiscoveryItems", () => {
  it("uses the active HNSW order, excludes self, and applies the documented category tie-break", async () => {
    const { db, calls } = scriptedDb([
      [
        {
          catalog_item_id: "charizard-base",
          category_names: ["Pokemon Cards"],
          category_slugs: ["pokemon-cards"],
          search_embedding: "[1,0]",
        },
      ],
      [candidate("unrelated", "Unrelated", 0.82, false), candidate("charizard-variant", "Charizard ex", 0.8, true)],
    ]);

    const result = await findSimilarDiscoveryItems(db, "charizard-base", { limit: 2 });

    expect(DISCOVERY_SIMILAR_ITEMS_CATEGORY_BONUS).toBe(0.03);
    expect(result?.mode).toBe("semantic");
    expect(result?.items.map((item) => item.catalog_item_id)).toEqual(["charizard-variant", "unrelated"]);
    expect(calls[1]?.sql).toContain("status = 'active'");
    expect(calls[1]?.sql).toContain("catalog_item_id <> $2");
    expect(calls[1]?.sql).toContain("search_embedding IS NOT NULL");
    expect(calls[1]?.sql).toContain("ORDER BY search_embedding <#> $1::halfvec(1024)");
    expect(calls[1]?.values).toEqual(["[1,0]", "charizard-base", ["pokemon-cards"], ["Pokemon Cards"], 8]);
  });

  it.each([
    { label: "the source embedding is NULL", semanticEnabled: true, embedding: null },
    { label: "the semantic kill-switch is off", semanticEnabled: false, embedding: "[1,0]" },
  ])("falls back to active same-category peers when $label", async ({ semanticEnabled, embedding }) => {
    const { db, calls } = scriptedDb([
      [
        {
          catalog_item_id: "source",
          category_names: ["Cards"],
          category_slugs: ["cards"],
          search_embedding: embedding,
        },
      ],
      [candidate("peer", "Category peer")],
    ]);

    const result = await findSimilarDiscoveryItems(db, "source", { semanticEnabled });

    expect(result).toMatchObject({ mode: "category", count: 1 });
    expect(result?.items[0]?.catalog_item_id).toBe("peer");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.sql).toContain("status = 'active'");
    expect(calls[1]?.sql).toContain("catalog_item_id <> $1");
    expect(calls[1]?.sql).toContain("category_slugs ?| $2::text[] OR category_names ?| $3::text[]");
  });

  it("falls back instead of surfacing a vector/index error", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (calls.length === 1) {
          return {
            rows: [
              {
                catalog_item_id: "source",
                category_names: ["Cards"],
                category_slugs: ["cards"],
                search_embedding: "[1,0]",
              },
            ] as Row[],
            rowCount: 1,
          };
        }
        if (calls.length === 2) throw new Error("vector index unavailable");
        return { rows: [candidate("fallback", "Fallback peer")] as Row[], rowCount: 1 };
      },
    };

    const result = await findSimilarDiscoveryItems(db, "source");

    expect(result?.mode).toBe("category");
    expect(result?.items[0]?.catalog_item_id).toBe("fallback");
    expect(calls).toHaveLength(3);
  });

  it("omits cleanly for unknown items or items with no semantic/category peers", async () => {
    const unknown = await findSimilarDiscoveryItems(scriptedDb([[]]).db, "missing");
    const empty = await findSimilarDiscoveryItems(
      scriptedDb([[{ catalog_item_id: "source", category_names: [], category_slugs: [], search_embedding: null }]]).db,
      "source",
    );

    expect(unknown).toBeNull();
    expect(empty).toEqual({ items: [], count: 0, mode: "none" });
  });
});

function scriptedDb(results: readonly (readonly unknown[])[]) {
  const calls: QueryCall[] = [];
  let index = 0;
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      const rows = (results[index++] ?? []) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, calls };
}

function candidate(catalogItemId: string, title: string, semanticSimilarity?: number, sameCategory?: boolean) {
  return {
    catalog_item_id: catalogItemId,
    slug: catalogItemId,
    title,
    subtitle: null,
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    semantic_similarity: semanticSimilarity,
    same_category: sameCategory,
  };
}
