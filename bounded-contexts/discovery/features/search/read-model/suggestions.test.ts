import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { DISCOVERY_SEARCH_SUGGESTION_LIMIT, suggestDiscoveryItems } from "./suggestions";

function createCapturingDb(rows: readonly Record<string, unknown>[] = [], servedCodes: readonly string[] = []) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      const result = sql.includes("unnest($1::text[])") ? servedCodes.map((set_code) => ({ set_code })) : rows;
      return { rows: result as Row[], rowCount: result.length };
    },
  };

  return { db, calls };
}

describe("suggestDiscoveryItems", () => {
  it.each([
    ["pkmn BB", "(pkmn | (pokemon)) & (BB:* | (booster <-> box:*))"],
    ["ETB missing", "(ETB | (elite <-> trainer <-> box)) & missing:*"],
    ["zard", "(zard:* | (charizard:*))"],
    ["ygo", "(ygo:* | (yu <-> gi <-> oh:*))"],
  ])("expands %s in English and simple with a prefix on each final alternative", async (query, expected) => {
    const { db, calls } = createCapturingDb();
    await suggestDiscoveryItems(db, query);
    expect(calls[0]?.sql).toContain("search_text @@ to_tsquery('english', $2)");
    expect(calls[0]?.sql).toContain("search_text_simple @@ to_tsquery('simple', $3)");
    expect(calls[0]?.values).toEqual(["active", expected, expected, 8]);
  });

  it("returns no suggestions and skips the database for an empty query", async () => {
    const { db, calls } = createCapturingDb();

    await expect(suggestDiscoveryItems(db, "   ")).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("uses the shared served-code lookup and protects literal collector tokens", async () => {
    const { db, calls } = createCapturingDb([], ["zard"]);
    await suggestDiscoveryItems(db, "zard 4/102");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.values).toEqual([["zard"]]);
    expect(calls[1]?.values).toEqual(["active", "zard & 4/102:*", "zard & (4 <-> 102:*)", 8]);
  });

  it("caps direct callers at 80 code points and strips raw tsquery syntax", async () => {
    const { db, calls } = createCapturingDb();
    await suggestDiscoveryItems(db, "zard " + "a".repeat(75) + " BB");
    expect(String(calls[0]?.values[1])).not.toContain("booster");
    await suggestDiscoveryItems(db, "ETB' | ! :* missing");
    expect(calls[1]?.values[1]).toBe("(ETB | (elite <-> trainer <-> box)) & missing:*");
    await suggestDiscoveryItems(db, "' | ! :*");
    expect(calls).toHaveLength(2);
  });

  it("prefix-matches the final token against the alias-aware simple vector", async () => {
    const { db, calls } = createCapturingDb([
      {
        catalog_item_id: "cat_1",
        title: "Charizard ex",
        subtitle: "Obsidian Flames 125/197",
        slug: "charizard-ex-cat-1",
        category: "Pokemon TCG",
      },
    ]);

    await expect(suggestDiscoveryItems(db, "Mega Char")).resolves.toEqual([
      {
        catalogItemId: "cat_1",
        title: "Charizard ex",
        subtitle: "Obsidian Flames 125/197",
        slug: "charizard-ex-cat-1",
        category: "Pokemon TCG",
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("status = $1");
    expect(calls[0]?.sql).toContain("catalog_item_id, title, subtitle, slug");
    expect(calls[0]?.sql).toContain("search_text_simple @@ to_tsquery('simple', $3)");
    expect(calls[0]?.sql).toContain("ts_rank(search_text_simple");
    expect(calls[0]?.values).toEqual(["active", "Mega & Char:*", "Mega & Char:*", DISCOVERY_SEARCH_SUGGESTION_LIMIT]);
  });

  it("enforces the strict result cap", async () => {
    const { db, calls } = createCapturingDb();

    await suggestDiscoveryItems(db, "char", 10_000);

    expect(calls[0]?.values.at(-1)).toBe(DISCOVERY_SEARCH_SUGGESTION_LIMIT);
  });
});
