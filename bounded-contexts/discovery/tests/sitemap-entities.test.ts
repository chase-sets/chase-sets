import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  DISCOVERY_SITEMAP_ENTITY_KINDS,
  DISCOVERY_SITEMAP_PAGE_SIZE,
  countDiscoveryPublicSitemapEntities,
  listDiscoveryPublicSitemapEntityPage,
} from "../support/market-support/queries";

describe("discovery sitemap entity coverage", () => {
  it("exposes every sitemap entity kind and a page size well under the protocol's 50,000-URL ceiling", () => {
    expect(DISCOVERY_SITEMAP_ENTITY_KINDS).toEqual(["items", "categories", "sellers", "listings", "sets"]);
    expect(DISCOVERY_SITEMAP_PAGE_SIZE).toBeLessThan(50000);
  });

  it("counts every entity kind independently instead of capping at a fixed row limit", async () => {
    const db = queryDbSequence([
      [{ count: "12000" }],
      [{ count: "3" }],
      [{ count: "0" }],
      [{ count: "5000" }],
      [{ count: "42" }],
    ]);

    const counts = await countDiscoveryPublicSitemapEntities(db);

    expect(counts).toEqual({ items: 12000, categories: 3, sellers: 0, listings: 5000, sets: 42 });
    expect(db.queries).toHaveLength(5);
    expect(db.queries[0]?.sql).toContain("discovery_item_detail_pages");
    expect(db.queries[1]?.sql).toContain("discovery_categories");
    expect(db.queries[2]?.sql).toContain("discovery_market_accounts");
    expect(db.queries[3]?.sql).toContain("discovery_market_listings");
    expect(db.queries[4]?.sql).toContain("discovery_search_catalog_reference_records");
  });

  it("pages items with a stable slug order and offset math that matches the requested page", async () => {
    const dbPageOne = queryDbSequence([
      [
        { slug: "charizard-cat_1", updated_at: "2026-07-03T00:00:00.000Z" },
        { slug: "blastoise-cat_2", updated_at: "2026-07-04T00:00:00.000Z" },
      ],
    ]);

    const pageOne = await listDiscoveryPublicSitemapEntityPage(dbPageOne, "items", 1);

    expect(pageOne).toEqual([
      { path: "/items/charizard-cat_1", updated_at: "2026-07-03T00:00:00.000Z" },
      { path: "/items/blastoise-cat_2", updated_at: "2026-07-04T00:00:00.000Z" },
    ]);
    expect(dbPageOne.queries[0]?.sql).toContain("ORDER BY slug ASC");
    expect(dbPageOne.queries[0]?.values).toEqual([DISCOVERY_SITEMAP_PAGE_SIZE, 0]);

    const dbPageThree = queryDbSequence([[]]);
    await listDiscoveryPublicSitemapEntityPage(dbPageThree, "items", 3);

    expect(dbPageThree.queries[0]?.values).toEqual([DISCOVERY_SITEMAP_PAGE_SIZE, DISCOVERY_SITEMAP_PAGE_SIZE * 2]);
  });

  it("maps each entity kind to its own crawlable public path prefix", async () => {
    const categoriesDb = queryDbSequence([[{ slug: "pokemon-tcg", updated_at: "2026-07-01T00:00:00.000Z" }]]);
    expect(await listDiscoveryPublicSitemapEntityPage(categoriesDb, "categories", 1)).toEqual([
      { path: "/categories/pokemon-tcg", updated_at: "2026-07-01T00:00:00.000Z" },
    ]);

    const sellersDb = queryDbSequence([[{ seller_slug: "card-vault-acc_1", updated_at: "2026-07-01T00:00:00.000Z" }]]);
    expect(await listDiscoveryPublicSitemapEntityPage(sellersDb, "sellers", 1)).toEqual([
      { path: "/accounts/card-vault-acc_1", updated_at: "2026-07-01T00:00:00.000Z" },
    ]);

    const listingsDb = queryDbSequence([[{ listing_slug: "charizard-lst_1", updated_at: "2026-07-01T00:00:00.000Z" }]]);
    expect(await listDiscoveryPublicSitemapEntityPage(listingsDb, "listings", 1)).toEqual([
      { path: "/listings/charizard-lst_1", updated_at: "2026-07-01T00:00:00.000Z" },
    ]);

    const setsDb = queryDbSequence([[{ slug: "surging-sparks", updated_at: "2026-07-01T00:00:00.000Z" }]]);
    expect(await listDiscoveryPublicSitemapEntityPage(setsDb, "sets", 1)).toEqual([
      { path: "/sets/surging-sparks", updated_at: "2026-07-01T00:00:00.000Z" },
    ]);
  });

  it("returns an empty page rather than throwing once a kind runs out of rows", async () => {
    const db = queryDbSequence([[]]);

    expect(await listDiscoveryPublicSitemapEntityPage(db, "items", 5)).toEqual([]);
  });
});

function queryDbSequence(
  responses: readonly Record<string, unknown>[][],
): PgQueryable & { queries: Array<{ sql: string; values: readonly unknown[] }> } {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  let call = 0;

  return {
    queries,
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      const rows = responses[call] ?? [];
      call += 1;
      return { rows, rowCount: rows.length };
    },
  };
}
