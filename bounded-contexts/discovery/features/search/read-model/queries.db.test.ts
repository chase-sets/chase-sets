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

async function walkAllPages(params: DiscoverySearchParams, pageSize: number): Promise<string[]> {
  const collected: string[] = [];
  let cursor: string | undefined;
  // Bound the loop well above the dataset size so a duplicate/drop regression
  // (infinite loop or premature stop) fails loudly instead of hanging.
  for (let page = 0; page < SEED_ITEMS.length + 5; page += 1) {
    const result = await searchDiscoveryItems(
      pool,
      { ...params, limit: pageSize, cursor },
      { loadFacets: false, loadMarketSummaries: false },
    );
    collected.push(...result.items.map((item) => item.catalog_item_id));
    if (!result.nextCursor) {
      return collected;
    }
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
});
