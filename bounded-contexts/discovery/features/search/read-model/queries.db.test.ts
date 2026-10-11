import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as discoveryModule } from "../../../index";
import { buildSimpleSearchQuery, foldSearchDiacritics } from "../domain/normalization";
import { searchDiscoveryItems, type DiscoverySearchParams } from "./queries";

// Rank ties are the failure mode from issue #3397: identical weight-class matches
// produce identical `ts_rank`, so the relevance sort's `title ASC, id ASC`
// tiebreakers become load-bearing. This dataset forces ties in EVERY sort mode:
//  - relevance: identical `search_text`, so every row shares one rank + baseMatch.
//  - title:     `Alpha Charizard` repeats (cat_b, cat_d) -> id tiebreaker.
//  - newest:    `2026-01-03` and `2026-01-01` each repeat -> id tiebreaker.
//  - price:     `10.00` repeats (cat_a, cat_b) and NULLs repeat (cat_c, cat_e).
const SEED_ITEMS = [
  { id: "cat_a", title: "Zeta Charizard", updatedAt: "2026-01-05T00:00:00.000Z", price: "10.00" },
  { id: "cat_b", title: "Alpha Charizard", updatedAt: "2026-01-01T00:00:00.000Z", price: "10.00" },
  { id: "cat_c", title: "Mu Charizard", updatedAt: "2026-01-03T00:00:00.000Z", price: null },
  { id: "cat_d", title: "Alpha Charizard", updatedAt: "2026-01-01T00:00:00.000Z", price: "20.00" },
  { id: "cat_e", title: "Beta Charizard", updatedAt: "2026-01-03T00:00:00.000Z", price: null },
] as const;

// Expected exhaustive order per sort, computed directly from each ORDER BY.
const EXPECTED_ORDER: Record<string, readonly string[]> = {
  // baseMatch DESC (tie), rank DESC (tie), title ASC, id ASC
  relevance: ["cat_b", "cat_d", "cat_e", "cat_c", "cat_a"],
  title_asc: ["cat_b", "cat_d", "cat_e", "cat_c", "cat_a"],
  title_desc: ["cat_a", "cat_c", "cat_e", "cat_d", "cat_b"],
  newest: ["cat_a", "cat_e", "cat_c", "cat_d", "cat_b"],
  price_asc: ["cat_a", "cat_b", "cat_d", "cat_c", "cat_e"],
  price_desc: ["cat_d", "cat_b", "cat_a", "cat_e", "cat_c"],
};

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
let pool: PgTransactionalPool;

async function seedItems(): Promise<void> {
  await pool.query("DELETE FROM discovery_search_items", []);
  for (const item of SEED_ITEMS) {
    await pool.query(
      `INSERT INTO discovery_search_items
         (catalog_item_id, slug, title, status, updated_at, lowest_price_amount, search_text, search_text_simple)
       VALUES ($1, $1, $2, 'active', $3::timestamptz, $4::numeric,
               to_tsvector('english', 'charizard'), to_tsvector('simple', 'charizard'))`,
      [item.id, item.title, item.updatedAt, item.price],
    );
  }
}

async function walkAllPages(
  params: DiscoverySearchParams,
  pageSize: number,
  db: PgTransactionalPool = pool,
  cursors: string[] = [],
): Promise<string[]> {
  const collected: string[] = [];
  let cursor: string | undefined;
  // Bound the loop well above every dataset size so a duplicate/drop regression
  // (infinite loop or premature stop) fails loudly instead of hanging.
  for (let page = 0; page < 20; page += 1) {
    const result = await searchDiscoveryItems(
      db,
      { ...params, limit: pageSize, cursor },
      { loadFacets: false, loadMarketSummaries: false },
    );
    collected.push(...result.items.map((item) => item.catalog_item_id));
    if (!result.nextCursor) {
      return collected;
    }
    cursors.push(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Cursor walk did not terminate — pagination is dropping or duplicating rows.");
}

describe("searchDiscoveryItems keyset pagination continuity across rank/tiebreaker ties", () => {
  beforeAll(async () => {
    if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for the Discovery cursor-pagination DB lane.");
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl, ["discovery"], "cursor_pagination");
    await ensureMultiContextTestDatabases(databaseBaseUrl, databaseUrls);
    const pools = createMultiContextTestPools(databaseUrls);
    pool = pools.discovery;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(discoveryModule, pool);
    await seedItems();
  }, 120_000);

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  const cases: readonly { sort: string; search?: string }[] = [
    { sort: "relevance", search: "charizard" },
    { sort: "title_asc" },
    { sort: "title_desc" },
    { sort: "newest" },
    { sort: "price_asc" },
    { sort: "price_desc" },
  ];

  // Small page sizes force page boundaries to fall INSIDE tie groups — the exact
  // condition that duplicated/dropped rows before the keyset predicate was fixed.
  for (const pageSize of [1, 2, 3]) {
    for (const { sort, search } of cases) {
      it(`returns every item exactly once, in order, for ${sort} (pageSize ${pageSize})`, async () => {
        const walked = await walkAllPages({ sort, search }, pageSize);

        // No duplicates across page boundaries.
        expect(new Set(walked).size).toBe(walked.length);
        // No drops: the full seeded set is present.
        expect([...walked].sort()).toEqual(SEED_ITEMS.map((item) => item.id).sort());
        // Correct, stable order matching the ORDER BY (independent of page size).
        expect(walked).toEqual(EXPECTED_ORDER[sort]);
      });
    }
  }

  it("terminates with a null nextCursor on the final page", async () => {
    const result = await searchDiscoveryItems(
      pool,
      { sort: "relevance", search: "charizard", limit: 100 },
      { loadFacets: false, loadMarketSummaries: false },
    );
    expect(result.items.map((item) => item.catalog_item_id)).toEqual(EXPECTED_ORDER.relevance);
    expect(result.nextCursor).toBeNull();
  });

  it("keeps sibling category counts when the selected category is excluded from its own fan-out", async () => {
    await pool.query(
      `UPDATE discovery_search_items
       SET category_slugs = CASE
         WHEN catalog_item_id IN ('cat_a', 'cat_b') THEN '["singles"]'::jsonb
         ELSE '["sealed"]'::jsonb
       END`,
      [],
    );

    const result = await searchDiscoveryItems(pool, { search: "charizard", category: "singles" });

    expect(result.category_counts).toEqual([
      { slug: "sealed", count: 3 },
      { slug: "singles", count: 2 },
    ]);
  });

  it("returns no sibling category count when the search genuinely matches only one category", async () => {
    await pool.query(
      `UPDATE discovery_search_items
       SET search_text = to_tsvector('english', CASE WHEN category_slugs @> '["singles"]'::jsonb THEN 'mewtwo' ELSE 'lugia' END),
           search_text_simple = to_tsvector('simple', CASE WHEN category_slugs @> '["singles"]'::jsonb THEN 'mewtwo' ELSE 'lugia' END)`,
      [],
    );

    const result = await searchDiscoveryItems(pool, { search: "mewtwo" });

    expect(result.category_counts).toEqual([{ slug: "singles", count: 2 }]);
    expect(result.category_counts.find((category) => category.slug === "sealed")?.count ?? 0).toBe(0);
  });
});

// Exact identity (#9102): every row carries the same lexemes and only the tsvector weight
// varies, so ranks order strictly A > B > C > D and equal weights tie exactly. Each exact
// row ranks BELOW a non-exact row, so only the tier can put it first.
const EXACT_QUERY = "Charizard ex";
const EXACT_TIER_ITEMS = [
  { id: "t0_alias", title: "Lizardon ex", subtitle: null, weight: "A" },
  { id: "t0_premium", title: "Charizard ex Premium Collection", subtitle: null, weight: "A" },
  { id: "t0_box", title: "Charizard ex Box", subtitle: null, weight: "B" },
  { id: "t1_case", title: "CHARIZARD-EX", subtitle: null, weight: "D" },
  { id: "t1_subtitle", title: "Charizard", subtitle: "ex", weight: "C" },
  { id: "t1_dup_b", title: "Charizard ex", subtitle: null, weight: "C" },
  { id: "t1_dup_a", title: "Charizard ex", subtitle: null, weight: "C" },
] as const;
// exactTier DESC, baseMatch DESC (tie), rank DESC, title ASC, id ASC
const EXACT_TIER_ORDER = ["t1_subtitle", "t1_dup_a", "t1_dup_b", "t1_case", "t0_premium", "t0_alias", "t0_box"];
const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const COMBINING_DAKUTEN = String.fromCodePoint(0x3099);
const RIGHT_SINGLE_QUOTE = String.fromCodePoint(0x2019);

describe("searchDiscoveryItems exact identity tier", () => {
  let exactPool: PgTransactionalPool;

  async function insertSearchRow(
    row: Readonly<{ id: string; title: string; subtitle: string | null; weight: string }>,
    lexemes: Readonly<{ english: string; simple: string }>,
  ) {
    await exactPool.query(
      `INSERT INTO discovery_search_items
         (catalog_item_id, slug, title, subtitle, status, category_slugs, search_text, search_text_simple)
       VALUES ($1, $1, $2, $3, 'active', '["cards"]'::jsonb,
               setweight(to_tsvector('english', $4), $6::"char"), setweight(to_tsvector('simple', $5), $6::"char"))`,
      [row.id, row.title, row.subtitle, lexemes.english, lexemes.simple, row.weight],
    );
  }

  async function seedExactTierItems() {
    await exactPool.query("DELETE FROM discovery_search_items", []);
    for (const item of EXACT_TIER_ITEMS) {
      await insertSearchRow(item, { english: "charizard ex", simple: "charizard ex" });
    }
  }

  // A higher-ranked control row is never exact, so the candidate leads only on tier 1.
  async function exactTierOf(search: string, title: string, subtitle: string | null = null): Promise<number> {
    await exactPool.query("DELETE FROM discovery_search_items", []);
    const lexemes = { english: foldSearchDiacritics(search), simple: buildSimpleSearchQuery(search) };
    await insertSearchRow({ id: "control", title: "Zz control row", subtitle: null, weight: "A" }, lexemes);
    await insertSearchRow({ id: "candidate", title, subtitle, weight: "D" }, lexemes);

    const result = await searchDiscoveryItems(exactPool, { search }, { loadFacets: false, loadMarketSummaries: false });
    const order = result.items.map((item) => item.catalog_item_id);
    expect([...order].sort()).toEqual(["candidate", "control"]);
    return order[0] === "candidate" ? 1 : 0;
  }

  function decodedCursor(cursor: string | null) {
    return cursor ? (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>) : null;
  }

  beforeAll(async () => {
    if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for the Discovery exact-identity DB lane.");
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl, ["discovery"], "exact_identity");
    await ensureMultiContextTestDatabases(databaseBaseUrl, databaseUrls);
    const pools = createMultiContextTestPools(databaseUrls);
    exactPool = pools.discovery;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(discoveryModule, exactPool);
  }, 120_000);

  afterAll(async () => {
    if (exactPool) await closeMultiContextTestPools({ discovery: exactPool });
  });

  it("exact identity outranks higher lexical rank", async () => {
    await seedExactTierItems();

    const result = await searchDiscoveryItems(
      exactPool,
      { search: EXACT_QUERY, includeTotal: true },
      { loadFacets: false, loadMarketSummaries: false },
    );

    expect(result.items.map((item) => item.catalog_item_id)).toEqual(EXACT_TIER_ORDER);
    // Every exact row ranks below the best non-exact rows on full-text rank alone.
    const rankOf = (id: string) => Number(result.items.find((item) => item.catalog_item_id === id)?.search_rank);
    expect(rankOf("t1_subtitle")).toBeLessThan(rankOf("t0_alias"));
    expect(rankOf("t1_case")).toBeLessThan(rankOf("t0_box"));
    expect(result.total).toBe(EXACT_TIER_ITEMS.length);
  });

  for (const pageSize of [1, 2, 3]) {
    it(`walks unequal exact tiers, both exact forms, and duplicate titles once each (pageSize ${pageSize})`, async () => {
      await seedExactTierItems();
      const cursors: string[] = [];

      const walked = await walkAllPages({ search: EXACT_QUERY }, pageSize, exactPool, cursors);

      expect(walked).toEqual(EXACT_TIER_ORDER);
      expect(cursors).toHaveLength(Math.ceil(EXACT_TIER_ITEMS.length / pageSize) - 1);
      for (const cursor of cursors) {
        expect(decodedCursor(cursor)).toMatchObject({ v: 2, tier: expect.any(Number) });
      }
    });
  }

  it("encodes the boundary row's tier into each v2 cursor and ends with a null cursor", async () => {
    await seedExactTierItems();
    const params = { search: EXACT_QUERY };
    const options = { loadFacets: false, loadMarketSummaries: false } as const;

    const lastExact = await searchDiscoveryItems(exactPool, { ...params, limit: 4 }, options);
    const firstNonExact = await searchDiscoveryItems(exactPool, { ...params, limit: 5 }, options);
    const everything = await searchDiscoveryItems(exactPool, { ...params, limit: 50 }, options);

    expect(decodedCursor(lastExact.nextCursor)).toMatchObject({ v: 2, id: "t1_case", tier: 1 });
    expect(decodedCursor(firstNonExact.nextCursor)).toMatchObject({ v: 2, id: "t0_premium", tier: 0 });
    expect(everything.items.map((item) => item.catalog_item_id)).toEqual(EXACT_TIER_ORDER);
    expect(everything.nextCursor).toBeNull();
  });

  it.each([
    ["identical title", "Charizard ex", "Charizard ex", null, 1],
    ["case on both sides", "CHARIZARD EX", "charizard ex", null, 1],
    ["title plus subtitle", "Charizard ex", "Charizard", "ex", 1],
    ["title alone despite a subtitle", "Charizard", "Charizard", "ex", 1],
    ["null subtitle", "Charizard", "Charizard", null, 1],
    ["empty subtitle", "Charizard", "Charizard", "", 1],
    ["precomposed query accent", "Pokémon Center", "Pokemon Center", null, 1],
    ["decomposed title accent", "Pokemon Center", `Poke${COMBINING_ACUTE}mon Center`, null, 1],
    ["decomposed query accent", `POKE${COMBINING_ACUTE}MON`, "pokémon", null, 1],
    ["punctuation", "Mr. Mime", "Mr Mime", null, 1],
    ["whitespace", "  Mr   Mime ", "Mr. Mime", null, 1],
    ["typographic apostrophe", "Farfetch'd", `Farfetch${RIGHT_SINGLE_QUOTE}d`, null, 1],
    ["katakana middle dot", "ピカチュウ・ex", "ピカチュウ ex", null, 1],
    ["fullwidth punctuation", "Charizard！", "Charizard", null, 1],
    ["decomposed dakuten", `カ${COMBINING_DAKUTEN}ルーラ`, "ガルーラ", null, 1],
    ["dakuten ガ/カ", "ガルーラ", "カルーラ", null, 0],
    ["handakuten パ/ハ", "パチリス", "ハチリス", null, 0],
    ["subtitle alone", "ex", "Charizard", "ex", 0],
    ["substring", "Charizard", "Charizard ex", null, 0],
    ["token-set reordering", "ex Charizard", "Charizard ex", null, 0],
    ["alias or description only", "Lizardon", "Charizard", null, 0],
  ])("normalizes %s symmetrically", async (_label, search, title, subtitle, expectedTier) => {
    expect(await exactTierOf(search, title, subtitle)).toBe(expectedTier);
  });

  it("returns no identity and no SQL error for a punctuation-only query", async () => {
    await exactPool.query("DELETE FROM discovery_search_items", []);
    await insertSearchRow(
      { id: "punctuation", title: "!?", subtitle: null, weight: "A" },
      { english: "!?", simple: "!?" },
    );

    const result = await searchDiscoveryItems(exactPool, { search: "!?・。", includeTotal: true });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("never broadens eligibility: an exact title without a lexical match is not returned", async () => {
    await seedExactTierItems();
    await insertSearchRow(
      { id: "exact_unmatched", title: EXACT_QUERY, subtitle: null, weight: "A" },
      {
        english: "lugia",
        simple: "lugia",
      },
    );

    const result = await searchDiscoveryItems(exactPool, { search: EXACT_QUERY, includeTotal: true });

    expect(result.items.map((item) => item.catalog_item_id)).toEqual(EXACT_TIER_ORDER);
    expect(result.total).toBe(EXACT_TIER_ITEMS.length);
  });

  it("legacy or invalid relevance cursor restarts with metadata", async () => {
    await seedExactTierItems();
    const legacyCursor = Buffer.from(
      JSON.stringify({
        id: "t0_premium",
        title: "Charizard ex Premium Collection",
        updatedAt: "2026-01-01T00:00:00.000Z",
        rank: 0.5,
        baseMatch: true,
        lowestPriceAmount: null,
      }),
      "utf8",
    ).toString("base64url");

    for (const cursor of [legacyCursor, "not-a-cursor"]) {
      const restarted = await searchDiscoveryItems(exactPool, {
        search: EXACT_QUERY,
        cursor,
        includeTotal: true,
        limit: 3,
      });

      expect(restarted.items.map((item) => item.catalog_item_id)).toEqual(EXACT_TIER_ORDER.slice(0, 3));
      expect(restarted.total).toBe(EXACT_TIER_ITEMS.length);
      expect(restarted.category_counts).toEqual([{ slug: "cards", count: EXACT_TIER_ITEMS.length }]);
      expect(decodedCursor(restarted.nextCursor)).toMatchObject({ v: 2, id: "t1_dup_b", tier: 1 });

      // A valid v2 continuation pages on from the restarted first page without first-page metadata.
      const next = await searchDiscoveryItems(exactPool, {
        search: EXACT_QUERY,
        cursor: restarted.nextCursor ?? undefined,
        includeTotal: true,
        limit: 3,
      });
      expect(next.items.map((item) => item.catalog_item_id)).toEqual(EXACT_TIER_ORDER.slice(3, 6));
      expect(next.total).toBeNull();
      expect(next.category_counts).toEqual([]);
      expect(next.facets).toEqual([]);
    }
  });

  it("counts relevance pages with only the base WHERE bindings", async () => {
    await seedExactTierItems();

    const offsetPage = await searchDiscoveryItems(
      exactPool,
      { search: EXACT_QUERY, category: "cards", offset: 2, limit: 2 },
      { loadFacets: false, loadMarketSummaries: false },
    );

    expect(offsetPage.items.map((item) => item.catalog_item_id)).toEqual(EXACT_TIER_ORDER.slice(2, 4));
    expect(offsetPage.total).toBe(EXACT_TIER_ITEMS.length);
  });
});
