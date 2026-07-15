import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { DISCOVERY_SEARCH_SUGGESTION_LIMIT, suggestDiscoveryItems } from "./suggestions";

function createCapturingDb(rows: readonly Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };

  return { db, calls };
}

describe("suggestDiscoveryItems", () => {
  it("returns no suggestions and skips the database for an empty query", async () => {
    const { db, calls } = createCapturingDb();

    await expect(suggestDiscoveryItems(db, "   ")).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("prefix-matches the final token against the alias-aware simple vector", async () => {
    const { db, calls } = createCapturingDb([
      {
        catalog_item_id: "cat_1",
        title: "Charizard ex",
        slug: "charizard-ex-cat-1",
        category: "Pokemon TCG",
      },
    ]);

    await expect(suggestDiscoveryItems(db, "Mega Char")).resolves.toEqual([
      {
        catalogItemId: "cat_1",
        title: "Charizard ex",
        slug: "charizard-ex-cat-1",
        category: "Pokemon TCG",
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("status = $1");
    expect(calls[0]?.sql).toContain("search_text_simple @@ to_tsquery('simple', $2)");
    expect(calls[0]?.sql).toContain("ORDER BY ts_rank(search_text_simple");
    expect(calls[0]?.values).toEqual(["active", "Mega & Char:*", DISCOVERY_SEARCH_SUGGESTION_LIMIT]);
  });

  it("enforces the strict result cap", async () => {
    const { db, calls } = createCapturingDb();

    await suggestDiscoveryItems(db, "char", 10_000);

    expect(calls[0]?.values.at(-1)).toBe(DISCOVERY_SEARCH_SUGGESTION_LIMIT);
  });
});
