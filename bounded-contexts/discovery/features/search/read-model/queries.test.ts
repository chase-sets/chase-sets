import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  discoverySearchCursorState,
  previewBulkAddSearchResults,
  searchDiscoveryItems,
  searchDiscoveryItemsByNaturalKey,
  searchDiscoverySemanticItems,
} from "./queries";
import { buildSimpleSearchQuery } from "../domain/normalization";
import { discoverySearchSchemaMigrations, discoverySearchSchemaSql } from "./schema";

// Duplicates the production encoders in queries.ts; change both together.
function encodeCursor(input: {
  id: string;
  title: string;
  updatedAt: string;
  rank?: number;
  baseMatch?: boolean;
  lowestPriceAmount?: string | null;
}) {
  return encodeCursorJson({
    id: input.id,
    title: input.title,
    updatedAt: input.updatedAt,
    rank: input.rank ?? 0,
    baseMatch: input.baseMatch ?? false,
    lowestPriceAmount: input.lowestPriceAmount ?? null,
  });
}

function encodeRelevanceCursor(input: { tier: number; baseMatch: boolean; rank: number; title: string; id: string }) {
  return encodeCursorJson({
    v: 2,
    id: input.id,
    title: input.title,
    updatedAt: "2026-05-16T00:00:00.000Z",
    rank: input.rank,
    baseMatch: input.baseMatch,
    tier: input.tier,
    lowestPriceAmount: null,
  });
}

function encodeCursorJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursorJson(cursor: string | null): unknown {
  return cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) : null;
}

function createCapturingDb(listRows: readonly Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      const rows = sql.startsWith("SELECT catalog_item_id") || sql.startsWith("SELECT * FROM (") ? listRows : [];
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };

  return { db, calls };
}

function listRow(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    catalog_item_id: id,
    title,
    subtitle: null,
    updated_at: "2026-05-16T00:00:00.000Z",
    lowest_price_amount: null,
    lowest_price_currency_code: null,
    visible_quantity: null,
    ...extra,
  };
}

function findListCall(calls: ReadonlyArray<{ sql: string; values: readonly unknown[] }>) {
  return calls.find((call) => call.sql.startsWith("SELECT catalog_item_id") || call.sql.startsWith("SELECT * FROM ("));
}

function expectBuyerVisibleListingPredicate(sql: string | undefined) {
  expect(sql).toBeDefined();
  const text = sql ?? "";
  expect(text).toContain("listing.status = 'active'");
  expect(text).toContain("account.seller_listing_availability_status = 'available'");
  expect(text).toContain("listing.product_measure_snapshot IS NOT NULL");
  expect(text).toContain("COALESCE(listing.supply_total_quantity, listing.quantity_cap)");
  expect(text).toContain("COALESCE(listing.active_held_quantity, 0)");
  expect(text).toContain("> 0");
}

describe("searchDiscoveryItems cursor paging", () => {
  it("db-profile-test-leaks-into-non-db-ci", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const file of [
      "features/search/read-model/queries.db.test.ts",
      "tests/acceptance/marketplace-search.test.ts",
    ]) {
      expect(scripts["test:db"].split(" ")).toContain(file);
      for (const profile of ["test:fast", "test:unit"]) {
        const excludes = (script: string) => [...script.matchAll(/--exclude (\S+)/g)].map((match) => match[1]);
        expect(excludes(scripts[profile])).toContain(file);
        // Bypass mutant: deleting only the DB exclusion exposes the file in
        // a non-DB profile even though it still enters the DB profile.
        expect(excludes(scripts[profile].replace(`--exclude ${file}`, ""))).not.toContain(file);
      }
    }
  });
  it.each([undefined, 1, "2", 3])("selected price cursor restarts without numeric pv=2 (%s)", async (pv) => {
    const params = {
      sort: "price_asc",
      dimensionFilters: [{ dimensionId: "finish", optionId: "foil" }],
      cursor: encodeCursorJson({ id: "old", title: "Old", lowestPriceAmount: "2", pv }),
      offset: 40,
      includeTotal: true,
    };
    expect(discoverySearchCursorState(params)).toBe("restarted");
    const { db, calls } = createCapturingDb();
    await searchDiscoveryItems(db, params);
    expect(calls.some((call) => call.sql.includes("SELECT COUNT(*) AS count"))).toBe(true);
    expect(findListCall(calls)?.sql).not.toContain("OFFSET");
    expect(findListCall(calls)?.values).not.toContain("old");
    expect(discoverySearchCursorState({ ...params, dimensionFilters: [] })).toBe("cursor");
  });

  it("same-listing variant commerce binds AND groups, OR options and selected minima everywhere", async () => {
    const dimensionFilters = [
      { dimensionId: "finish", optionId: "foil" },
      { dimensionId: "finish", optionId: "etched" },
      { dimensionId: "condition", optionId: "mint" },
    ];
    const { db, calls } = createCapturingDb([listRow("card", "Card", { lowest_price_amount: "20" })]);
    await searchDiscoveryItems(db, { dimensionFilters, priceMax: "3", inStock: true });
    const list = findListCall(calls)!;
    expect(list.sql).toContain("selected_market.lowest_price_amount <=");
    expect(list.sql).toContain("selected_market.total_visible_quantity > 0");
    expect(list.sql).toContain("COUNT(DISTINCT price_currency_code) = 1");
    expect(list.sql).toMatch(/listing\.selected_options @> \$\d+::jsonb OR listing\.selected_options @> \$\d+::jsonb/);
    expectBuyerVisibleListingPredicate(list.sql);
    const hydration = calls.find((call) => call.sql.startsWith("WITH startable_listing"))!;
    expect(hydration.values).toEqual([["card"], ...dimensionFilters.map((filter) => JSON.stringify([filter]))]);
    expect(hydration.sql).toContain("listing.selected_options @> $2::jsonb");
  });

  it.each(["price_asc", "price_desc"])("encodes selected-price pv=2 from selected minima for %s", async (sort) => {
    const { db } = createCapturingDb([
      listRow("a", "A", { lowest_price_amount: "20" }),
      listRow("b", "B", { lowest_price_amount: "30" }),
    ]);
    const dimensionFilters = [{ dimensionId: "finish", optionId: "foil" }];
    const page = await searchDiscoveryItems(db, { sort, dimensionFilters, limit: 1 });
    expect(decodeCursorJson(page.nextCursor)).toMatchObject({ pv: 2, lowestPriceAmount: "20" });
    expect(discoverySearchCursorState({ sort, dimensionFilters, cursor: page.nextCursor! })).toBe("cursor");
  });

  it("installs the identity-term table and concurrent trigram index idempotently", () => {
    expect(discoverySearchSchemaSql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(discoverySearchSchemaSql).toContain("CREATE TABLE IF NOT EXISTS discovery_search_item_identity_terms");
    expect(discoverySearchSchemaSql).toContain("PRIMARY KEY (catalog_item_id, term)");
    const migration = discoverySearchSchemaMigrations.find(
      (entry) => entry.migrationId === "20261008_discovery_search_identity_terms",
    );
    expect(migration?.statements).toEqual([
      "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
      expect.stringContaining("PRIMARY KEY (catalog_item_id, term)"),
      expect.stringContaining("CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_item_identity_terms_trgm_idx"),
    ]);
    expect(migration?.statements[2]).toContain("USING gin (term gin_trgm_ops)");
  });

  it("counts a requested first page but never a cursor page", async () => {
    const firstPage = createCapturingDb();
    await searchDiscoveryItems(
      firstPage.db,
      { includeTotal: true, limit: 24 },
      { loadFacets: false, loadMarketSummaries: false },
    );

    expect(firstPage.calls.some((call) => call.sql.includes("SELECT COUNT(*) AS count"))).toBe(true);

    const cursorPage = createCapturingDb();
    await searchDiscoveryItems(
      cursorPage.db,
      {
        includeTotal: true,
        cursor: encodeCursor({ id: "cat_001", title: "Bulbasaur", updatedAt: "2026-05-16T00:00:00.000Z" }),
        limit: 24,
      },
      { loadFacets: false, loadMarketSummaries: false },
    );

    expect(cursorPage.calls.some((call) => call.sql.includes("SELECT COUNT(*) AS count"))).toBe(false);
  });

  it("issues only the result query and no facet queries for load-more requests", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      cursor: encodeCursor({
        id: "cat_001",
        title: "Bulbasaur",
        updatedAt: "2026-05-16T00:00:00.000Z",
      }),
      limit: 24,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("SELECT catalog_item_id");
    expect(calls[0]?.sql).not.toContain("AS summaries");
    expect(calls[0]?.sql).not.toContain("jsonb_array_elements");
  });

  it("returns the ordered structured display badge list without reshaping it", async () => {
    const badges = [
      { kind: "set-code", label: "BS" },
      { kind: "number", label: "4/102" },
      { kind: "rarity", label: "Rare Holo" },
    ] as const;
    const db: PgQueryable = {
      query: async <Row>(sql: string) => ({
        rows: (sql.includes("SELECT catalog_item_id")
          ? [
              {
                catalog_item_id: "cat_1",
                slug: "charizard-cat-1",
                language_code: "en",
                title_i18n: {},
                title: "Charizard",
                subtitle_i18n: null,
                subtitle: null,
                display_badges: badges,
                description_i18n: {},
                description: "",
                blueprint_id: null,
                blueprint_name: null,
                status: "active",
                category_names: [],
                category_slugs: [],
                tags: [],
                image_urls: [],
                product_asset_sets: [],
                image_fallback: null,
                updated_at: "2026-07-12T00:00:00.000Z",
              },
            ]
          : []) as Row[],
        rowCount: sql.includes("SELECT catalog_item_id") ? 1 : 0,
      }),
    };

    const result = await searchDiscoveryItems(db, { limit: 1 }, { loadMarketSummaries: false, loadFacets: false });

    expect(result.items[0]?.display_badges).toEqual(badges);
  });

  it("keeps keyset sort queries aligned with ledgered composite indexes", async () => {
    const statements =
      discoverySearchSchemaMigrations.find(
        (migration) => migration.migrationId === "20260703_discovery_search_keyset_indexes",
      )?.statements ?? [];
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      sort: "newest",
      cursor: encodeCursor({
        id: "cat_002",
        title: "Bulbasaur",
        updatedAt: "2026-05-16T00:00:00.000Z",
      }),
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("FROM discovery_search_items"));
    expect(listCall?.sql).toContain("display_badges");
    expect(listCall?.sql).toContain("WHERE status = $1 AND (updated_at, catalog_item_id) <");
    expect(listCall?.sql).toContain("ORDER BY updated_at DESC, catalog_item_id DESC");
    expect(discoverySearchSchemaSql).not.toContain("discovery_search_items_status_title_catalog_item_idx");
    expect(discoverySearchSchemaSql).not.toContain("discovery_search_items_status_updated_catalog_item_idx");
    expect(statements).toEqual([
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_status_title_catalog_item_idx",
      ),
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_status_updated_catalog_item_idx",
      ),
    ]);
    expect(statements[0]).toContain("ON discovery_search_items (status, title, catalog_item_id)");
    expect(statements[1]).toContain("ON discovery_search_items (status, updated_at DESC, catalog_item_id DESC)");
  });

  it("keeps price-sort keysets aligned with NULLS-LAST market-signal indexes", async () => {
    const migration = discoverySearchSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260714_discovery_search_market_signal_indexes",
    );
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(
      db,
      {
        sort: "price_asc",
        cursor: encodeCursor({
          id: "cat_002",
          title: "Bulbasaur",
          updatedAt: "2026-05-16T00:00:00.000Z",
          lowestPriceAmount: "12.50",
        }),
        limit: 24,
      },
      { loadFacets: false, loadMarketSummaries: false },
    );

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(discoverySearchSchemaSql).toContain("lowest_price_amount numeric NULL");
    expect(discoverySearchSchemaSql).toContain("visible_quantity integer NULL");
    expect(migration?.statements).toEqual([
      expect.stringContaining("discovery_search_items_status_price_asc_idx"),
      expect.stringContaining("discovery_search_items_status_price_desc_idx"),
    ]);
    expect(migration?.statements[0]).toContain("lowest_price_amount ASC NULLS LAST, catalog_item_id ASC");
    expect(migration?.statements[1]).toContain("lowest_price_amount DESC NULLS LAST, catalog_item_id DESC");
    expect(listCall?.sql).toContain(
      "(lowest_price_amount > $2::numeric OR (lowest_price_amount = $2::numeric AND catalog_item_id > $3) OR lowest_price_amount IS NULL)",
    );
    expect(listCall?.sql).toContain("ORDER BY lowest_price_amount ASC NULLS LAST, catalog_item_id ASC");
    expect(listCall?.values).toEqual(["active", "12.50", "cat_002", 25]);
  });

  it("paginates deterministically within the NULL-price tail in both directions", async () => {
    for (const [sort, comparison, direction] of [
      ["price_asc", ">", "ASC"],
      ["price_desc", "<", "DESC"],
    ] as const) {
      const { db, calls } = createCapturingDb();

      await searchDiscoveryItems(
        db,
        {
          sort,
          cursor: encodeCursor({
            id: "cat_zero_listing",
            title: "Zero listing",
            updatedAt: "2026-05-16T00:00:00.000Z",
            lowestPriceAmount: null,
          }),
          limit: 24,
        },
        { loadFacets: false, loadMarketSummaries: false },
      );

      const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
      expect(listCall?.sql).toContain(`lowest_price_amount IS NULL AND catalog_item_id ${comparison} $2`);
      expect(listCall?.sql).toContain(
        `ORDER BY lowest_price_amount ${direction} NULLS LAST, catalog_item_id ${direction}`,
      );
      expect(listCall?.values).toEqual(["active", "cat_zero_listing", 25]);
    }
  });

  it("applies price range and in-stock constraints to result and facet filters", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      priceMin: "10.00",
      priceMax: "25.50",
      inStock: true,
      limit: 24,
    });

    const searchCalls = calls.filter((call) => call.sql.includes("discovery_search_items"));
    expect(searchCalls.length).toBeGreaterThan(1);
    for (const call of searchCalls) {
      expect(call.sql).toContain("lowest_price_amount >= $2::numeric");
      expect(call.sql).toContain("lowest_price_amount <= $3::numeric");
      expect(call.sql).toContain("visible_quantity > 0");
    }
    expect(searchCalls[0]?.values.slice(0, 3)).toEqual(["active", "10.00", "25.50"]);
  });

  it("uses a ledgered halfvec reshape and concurrent HNSW index", () => {
    const migration = discoverySearchSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260710_discovery_search_voyage_embeddings",
    );

    expect(discoverySearchSchemaSql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(discoverySearchSchemaSql).toContain("search_embedding halfvec(1024)");
    expect(discoverySearchSchemaSql).not.toContain("search_embedding vector(1536)");
    expect(discoverySearchSchemaSql).toContain("embedding_model text NULL");
    expect(discoverySearchSchemaSql).not.toContain("discovery_search_items_embedding_hnsw_idx");
    expect(migration?.statements[0]).toBe("SET lock_timeout = '5s';");
    expect(migration?.statements[1]).toContain("ALTER COLUMN search_embedding TYPE halfvec(1024)");
    expect(migration?.statements[2]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(migration?.statements[2]).toContain("halfvec_ip_ops");
    const activeIndexMigration = discoverySearchSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260710_discovery_search_active_embedding_hnsw",
    );
    expect(activeIndexMigration?.statements[0]).toBe("SET lock_timeout = '5s';");
    expect(activeIndexMigration?.statements[1]).toContain("DROP INDEX CONCURRENTLY IF EXISTS");
    expect(activeIndexMigration?.statements[2]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(activeIndexMigration?.statements[2]).toContain("halfvec_ip_ops");
    expect(activeIndexMigration?.statements[2]).toContain("WHERE status = 'active' AND search_embedding IS NOT NULL");
  });

  it("ledgers category lifecycle state used to invalidate Search Index facets", () => {
    const migration = discoverySearchSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260723_discovery_search_category_lifecycle",
    );

    expect(discoverySearchSchemaSql).toContain("status text NOT NULL DEFAULT 'active'");
    expect(discoverySearchSchemaSql).toContain("last_global_position bigint NOT NULL DEFAULT 0");
    expect(migration?.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'"),
        expect.stringContaining("ADD COLUMN IF NOT EXISTS last_global_position bigint NOT NULL DEFAULT 0"),
        expect.stringContaining(
          "CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_catalog_categories_status_idx",
        ),
      ]),
    );
  });

  it("uses the inner-product HNSW order and preserves every active filter for semantic candidates", async () => {
    const { db, calls } = createCapturingDb();
    const embedding = Array.from({ length: 1_024 }, (_, index) => (index === 0 ? 1 : 0));

    await searchDiscoverySemanticItems(
      db,
      {
        search: "ignored by vector filter",
        category: "pokemon",
        tag: "vintage",
        fieldFilters: [{ fieldId: "rarity", value: "Rare" }],
        status: "active",
      },
      embedding,
      { limit: 24 },
    );

    const semanticCall = calls.find((call) => call.sql.includes("semantic_similarity"));
    expect(semanticCall?.sql).toContain("item.status = $1");
    expect(semanticCall?.sql).toContain("item.category_names");
    expect(semanticCall?.sql).toContain("item.tags @>");
    expect(semanticCall?.sql).toContain("jsonb_array_elements(item.field_filter_values)");
    expect(semanticCall?.sql).toContain("item.search_embedding <#> $6::halfvec(1024)");
    expect(semanticCall?.sql).toContain("ORDER BY item.search_embedding <#> $6::halfvec(1024) ASC");
    expect(semanticCall?.sql).not.toContain("plainto_tsquery");
    expect(semanticCall?.values.slice(0, 5)).toEqual([
      "active",
      JSON.stringify(["pokemon"]),
      JSON.stringify(["vintage"]),
      "rarity",
      ["rare"],
    ]);
    expect(semanticCall?.values.at(-2)).toBe(0.52);
    expect(semanticCall?.values.at(-1)).toBe(24);
  });

  it.each([
    {
      sort: "title_asc",
      cursor: encodeCursor({
        id: "cat_002",
        title: "Bulbasaur",
        updatedAt: "2026-05-16T00:00:00.000Z",
      }),
      expectedCondition: "(title, catalog_item_id) >",
      expectedOrder: "ORDER BY title ASC, catalog_item_id ASC",
      expectedCursorValues: ["Bulbasaur", "cat_002"],
    },
    {
      sort: "title_desc",
      cursor: encodeCursor({
        id: "cat_002",
        title: "Bulbasaur",
        updatedAt: "2026-05-16T00:00:00.000Z",
      }),
      expectedCondition: "(title, catalog_item_id) <",
      expectedOrder: "ORDER BY title DESC, catalog_item_id DESC",
      expectedCursorValues: ["Bulbasaur", "cat_002"],
    },
    {
      sort: "newest",
      cursor: encodeCursor({
        id: "cat_002",
        title: "Bulbasaur",
        updatedAt: "2026-05-16T00:00:00.000Z",
      }),
      expectedCondition: "(updated_at, catalog_item_id) <",
      expectedOrder: "ORDER BY updated_at DESC, catalog_item_id DESC",
      expectedCursorValues: ["2026-05-16T00:00:00.000Z", "cat_002"],
    },
  ])(
    "applies stable cursor ordering for $sort",
    async ({ sort, cursor, expectedCondition, expectedOrder, expectedCursorValues }) => {
      const { db, calls } = createCapturingDb();

      await searchDiscoveryItems(db, { sort, cursor, limit: 24 });

      const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
      expect(listCall?.sql).toContain(expectedCondition);
      expect(listCall?.sql).toContain(expectedOrder);
      expect(listCall?.sql).toContain("LIMIT $4");
      expect(listCall?.sql).not.toContain("OFFSET");
      expect(listCall?.values).toEqual(["active", ...expectedCursorValues, 25]);
    },
  );

  it("applies the complete exact-tier keyset for v2 relevance cursors", async () => {
    const { db, calls } = createCapturingDb();
    const cursor = encodeRelevanceCursor({ tier: 1, baseMatch: true, rank: 0.75, title: "Bulbasaur", id: "cat_002" });

    await searchDiscoveryItems(db, {
      search: "pokemon",
      sort: "relevance",
      cursor,
      limit: 24,
    });

    const listCall = findListCall(calls);
    expect(listCall?.sql).toContain("(ts_rank(search_text");
    // Rank is computed purely from the item's own folded tsvectors — no correlated
    // content-rank subquery and no 0.20 content dampener.
    expect(listCall?.sql).not.toContain("discovery_search_product_contents");
    expect(listCall?.sql).not.toContain("* 0.20");
    // Mixed-direction ORDER BY (tier/baseMatch/rank DESC, title/id ASC) splits the keyset
    // by direction rather than applying one row-value comparison to every column.
    expect(listCall?.sql).toContain(
      "WHERE ((search_exact_tier, search_base_match::integer, search_rank) < ($5::integer, $6::integer, $7::real)" +
        " OR ((search_exact_tier, search_base_match::integer, search_rank) = ($5::integer, $6::integer, $7::real)" +
        " AND (title, catalog_item_id) > ($8, $9)))",
    );
    expect(listCall?.sql).toContain(
      "ORDER BY search_exact_tier DESC, search_base_match DESC, search_rank DESC, title ASC, catalog_item_id ASC",
    );
    expect(listCall?.sql).toContain("LIMIT $10");
    expect(listCall?.sql).not.toContain("OFFSET $");
    expect(listCall?.values).toEqual([
      "active",
      "pokemon",
      "pokemon",
      "pokemon",
      1,
      1,
      0.75,
      "Bulbasaur",
      "cat_002",
      25,
    ]);
  });

  it("selects the exact identity tier once per qualifying row from one SQL normalization of both sides", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, { search: "Pokémon", limit: 24 }, { loadFacets: false, loadMarketSummaries: false });

    const sql = findListCall(calls)?.sql ?? "";
    const normalized = (text: string) => `lower(btrim(regexp_replace(regexp_replace(normalize(${text}, NFD), '(?<=[`;
    // One expression shape normalizes the bound raw query, the title, and title + subtitle.
    expect(sql).toContain(`CASE ${normalized("$4")}`);
    expect(sql).toContain(`${normalized("title")}`);
    expect(sql).toContain(`COLLATE "C") AS search_title_identity`);
    expect(sql).toContain(
      `WHEN '' THEN 0 WHEN search_title_identity THEN 1 WHEN CASE WHEN search_title_identity = '' OR starts_with(${normalized("$4")}`,
    );
    expect(sql).toContain(`search_title_identity || ' ') THEN ${normalized("title || ' ' || subtitle")}`);
    expect(sql).toContain(`COLLATE "C") END THEN 1 ELSE 0 END AS search_exact_tier`);
    // Explicit code-point ranges, never LC_CTYPE-dependent classes or extension folding.
    expect(sql).not.toMatch(/\[\[:|\\w|\\p\{|unaccent/);
    // The fenced derived table computes rank, base match, and the normalized title once per
    // qualifying row; the tier compares that text, and the outer query orders and pages it.
    expect(sql).toMatch(/^SELECT \* FROM \(\s*SELECT \*, CASE /);
    expect(sql).toContain(" AS search_rank, ");
    expect(sql).toContain(" AS search_base_match, ");
    expect(sql.match(/AS search_exact_tier/g)).toHaveLength(1);
    expect(sql.match(/AS search_title_identity/g)).toHaveLength(1);
    expect(sql).toContain("OFFSET 0\n      ) AS normalized\n    ) AS candidate");
    expect(sql).toContain(
      "ORDER BY search_exact_tier DESC, search_base_match DESC, search_rank DESC, title ASC, catalog_item_id ASC",
    );
    // The query side is bound raw (never folded in JS) after the base WHERE values.
    expect(calls[0]?.values).toEqual(["active", "Pokemon", "Pokemon", "Pokémon", 25]);
  });

  it("binds an empty exact query when the oracle normalizes the search to nothing", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, { search: "¡¿…!!", limit: 24 }, { loadFacets: false, loadMarketSummaries: false });

    expect(findListCall(calls)?.values).toEqual(["active", "¡¿…!!", "", "", 25]);
  });

  it("keeps explicit sorts and text-free relevance off the exact tier", async () => {
    for (const params of [{ search: "pokemon", sort: "title_asc" }, { sort: "relevance" }] as const) {
      const { db, calls } = createCapturingDb();

      await searchDiscoveryItems(db, { ...params, limit: 24 }, { loadFacets: false, loadMarketSummaries: false });

      const listCall = findListCall(calls);
      expect(listCall?.sql).not.toContain("search_exact_tier");
      expect(listCall?.sql).toContain("ORDER BY title ASC, catalog_item_id ASC");
    }
  });

  it("encodes v2 relevance cursors with the tier and leaves explicit-sort cursors unversioned", async () => {
    const relevance = createCapturingDb([
      listRow("cat_exact", "Charizard ex", {
        search_rank: 0.25,
        search_base_match: true,
        search_exact_tier: 1,
        search_title_identity: "charizard ex",
      }),
      listRow("cat_next", "Charizard ex Box", { search_rank: 0.5, search_base_match: true, search_exact_tier: 0 }),
    ]);
    const relevancePage = await searchDiscoveryItems(
      relevance.db,
      { search: "Charizard ex", limit: 1 },
      { loadFacets: false, loadMarketSummaries: false },
    );

    expect(decodeCursorJson(relevancePage.nextCursor)).toEqual({
      v: 2,
      id: "cat_exact",
      title: "Charizard ex",
      updatedAt: "2026-05-16T00:00:00.000Z",
      rank: 0.25,
      baseMatch: true,
      tier: 1,
      lowestPriceAmount: null,
    });
    expect(relevancePage.items[0]).not.toHaveProperty("search_exact_tier");
    expect(relevancePage.items[0]).not.toHaveProperty("search_title_identity");

    const titleSort = createCapturingDb([listRow("cat_a", "Alpha"), listRow("cat_b", "Beta")]);
    const titlePage = await searchDiscoveryItems(
      titleSort.db,
      { search: "Charizard ex", sort: "title_asc", limit: 1 },
      { loadFacets: false, loadMarketSummaries: false },
    );

    expect(decodeCursorJson(titlePage.nextCursor)).toEqual({
      id: "cat_a",
      title: "Alpha",
      updatedAt: "2026-05-16T00:00:00.000Z",
      rank: 0,
      baseMatch: false,
      lowestPriceAmount: null,
    });
  });

  it("counts relevance first pages with only the base WHERE values", async () => {
    for (const params of [
      { includeTotal: true, limit: 24 },
      { offset: 48, limit: 24 },
    ]) {
      const { db, calls } = createCapturingDb();

      await searchDiscoveryItems(
        db,
        { search: "pokemon", category: "cards", ...params },
        { loadFacets: false, loadMarketSummaries: false },
      );

      const countCall = calls.find((call) => call.sql.startsWith("SELECT COUNT(*) AS count"));
      expect(countCall?.sql).toContain("WHERE status = $1 AND (search_text @@ plainto_tsquery('english', $2)");
      expect(countCall?.sql).not.toContain("$5");
      expect(countCall?.values).toEqual(["active", "pokemon", "pokemon", JSON.stringify(["cards"])]);
    }
  });

  it.each([
    [
      "an unversioned legacy cursor",
      encodeCursor({ id: "cat_002", title: "Bulbasaur", updatedAt: "2026", rank: 0.75, baseMatch: true }),
    ],
    ["a malformed cursor", "not-a-cursor"],
    ["array JSON", encodeCursorJson([2, 1, true, 0.75, "Bulbasaur", "cat_002"])],
    [
      "a cursor missing its tier",
      encodeCursorJson({ v: 2, id: "cat_002", title: "Bulbasaur", rank: 0.75, baseMatch: true }),
    ],
    [
      "a wrong cursor version",
      encodeCursorJson({ v: 3, id: "cat_002", title: "Bulbasaur", rank: 0.75, baseMatch: true, tier: 1 }),
    ],
    [
      "an out-of-range tier",
      encodeCursorJson({ v: 2, id: "cat_002", title: "Bulbasaur", rank: 0.75, baseMatch: true, tier: 2 }),
    ],
    ["a hybrid cursor", encodeCursorJson({ kind: "hybrid", offset: 24 })],
  ])("legacy or invalid relevance cursor restarts with metadata: %s", async (_label, cursor) => {
    const { db, calls } = createCapturingDb();
    const params = { search: "pokemon", category: "cards", cursor, includeTotal: true, limit: 24 };

    expect(discoverySearchCursorState(params)).toBe("restarted");
    await searchDiscoveryItems(db, params);

    const listCall = findListCall(calls);
    expect(listCall?.sql).not.toContain("search_exact_tier, search_base_match::integer, search_rank) <");
    expect(listCall?.values).toEqual(["active", "pokemon", "pokemon", JSON.stringify(["cards"]), "pokemon", 25]);
    expect(calls.some((call) => call.sql.startsWith("SELECT COUNT(*) AS count"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("AS summaries"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("AS slug, COUNT(DISTINCT item.catalog_item_id)"))).toBe(true);
  });

  it.each([
    [
      "an unversioned legacy cursor",
      encodeCursor({ id: "cat_old", title: "Old", updatedAt: "2026", rank: 0.9, baseMatch: true }),
    ],
    ["a malformed cursor", "not-a-cursor"],
    [
      "a wrong cursor version",
      encodeCursorJson({ v: 3, id: "cat_old", title: "Old", rank: 0.9, baseMatch: true, tier: 1 }),
    ],
  ])("restarts %s with an offset at the first page", async (_label, cursor) => {
    const { db, calls } = createCapturingDb([
      listRow("cat_exact", "Charizard ex", { search_rank: 0.25, search_base_match: true, search_exact_tier: 1 }),
      listRow("cat_next", "Charizard ex Box", { search_rank: 0.5, search_base_match: true, search_exact_tier: 0 }),
    ]);

    const page = await searchDiscoveryItems(
      db,
      { search: "Charizard ex", cursor, offset: 48, limit: 1, includeTotal: true },
      { loadFacets: false, loadMarketSummaries: false },
    );

    const listCall = findListCall(calls);
    expect(listCall?.sql).toContain("LIMIT $5");
    expect(listCall?.sql).not.toContain("OFFSET $");
    expect(listCall?.values).toEqual(["active", "Charizard ex", "Charizard ex", "Charizard ex", 2]);
    expect(calls.find((call) => call.sql.startsWith("SELECT COUNT(*) AS count"))?.values).toEqual([
      "active",
      "Charizard ex",
      "Charizard ex",
    ]);
    expect(page.items.map((item) => item.catalog_item_id)).toEqual(["cat_exact"]);
    expect(decodeCursorJson(page.nextCursor)).toMatchObject({ v: 2, id: "cat_exact", tier: 1 });
  });

  it("keeps intentional offset paging when no cursor is supplied", async () => {
    const { db, calls } = createCapturingDb([listRow("cat_next", "Charizard ex Box", { search_exact_tier: 0 })]);

    const page = await searchDiscoveryItems(
      db,
      { search: "Charizard ex", offset: 48, limit: 1 },
      { loadFacets: false, loadMarketSummaries: false },
    );

    const listCall = findListCall(calls);
    expect(listCall?.sql).toContain("LIMIT $5 OFFSET $6");
    expect(listCall?.values).toEqual(["active", "Charizard ex", "Charizard ex", "Charizard ex", 1, 48]);
    expect(calls.some((call) => call.sql.startsWith("SELECT COUNT(*) AS count"))).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it("classifies only cursors the active ordering can decode as continuations", () => {
    const relevanceCursor = encodeRelevanceCursor({ tier: 0, baseMatch: true, rank: 0.5, title: "A", id: "cat_a" });
    const legacyCursor = encodeCursor({ id: "cat_a", title: "A", updatedAt: "2026-05-16T00:00:00.000Z" });

    expect(discoverySearchCursorState({ search: "pokemon" })).toBe("fresh");
    expect(discoverySearchCursorState({ search: "pokemon", cursor: relevanceCursor })).toBe("cursor");
    expect(discoverySearchCursorState({ search: "pokemon", sort: "relevance", cursor: legacyCursor })).toBe(
      "restarted",
    );
    // Explicit sorts and text-free relevance keep their unversioned keysets.
    expect(discoverySearchCursorState({ search: "pokemon", sort: "newest", cursor: legacyCursor })).toBe("cursor");
    expect(discoverySearchCursorState({ cursor: legacyCursor })).toBe("cursor");
    expect(discoverySearchCursorState({ sort: "title_asc", cursor: "not-a-cursor" })).toBe("restarted");
  });

  it("matches container contents through the folded item tsvector without a correlated subquery", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      search: "Charizard",
      sort: "relevance",
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    // Product-contents text is folded into the item's tsvector at projection time,
    // so the text match is a pure GIN-indexable @@ predicate: no correlated EXISTS
    // in the filter and no correlated content-rank subquery in the ORDER BY.
    expect(listCall?.sql).not.toContain("EXISTS");
    expect(listCall?.sql).not.toContain("discovery_search_product_contents");
    expect(listCall?.sql).not.toContain("content_type_search_weight");
    expect(listCall?.sql).not.toContain("* 0.20");
    expect(listCall?.sql).toContain(
      "(search_text @@ plainto_tsquery('english', $2) OR search_text_simple @@ plainto_tsquery('simple', $3))",
    );
    expect(listCall?.sql).toContain(
      "(search_text @@ plainto_tsquery('english', $2) OR search_text_simple @@ plainto_tsquery('simple', $3)) AS search_base_match",
    );
    expect(listCall?.values).toEqual(["active", "Charizard", "Charizard", "Charizard", 25]);
  });

  it("applies first-class reference filters by Reference Type", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      referenceFilters: [
        { typeKey: "series", referenceId: "ref_mega_evolution" },
        { typeKey: "series", referenceId: "ref_scarlet_violet" },
        { typeKey: "product-line", referenceId: "ref_pokemon_tcg" },
      ],
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(listCall?.sql).toContain("jsonb_array_elements(reference_filter_values)");
    expect(listCall?.sql).toContain("facet.value->>'typeKey' = $2");
    expect(listCall?.sql).toContain("facet.value->>'typeKey' = $4");
    expect(listCall?.values).toEqual([
      "active",
      "series",
      ["ref_mega_evolution", "ref_scarlet_violet"],
      "product-line",
      ["ref_pokemon_tcg"],
      25,
    ]);
  });

  it("filters listed items by selected product options when dimension filters are active", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      marketActivity: "listings",
      dimensionFilters: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(listCall?.sql).toContain("FROM discovery_market_listings AS listing");
    expectBuyerVisibleListingPredicate(listCall?.sql);
    expect(listCall?.sql).toContain("listing.selected_options @> $4::jsonb");
    expect(listCall?.values).toEqual([
      "active",
      "dim_condition",
      ["opt_near_mint"],
      JSON.stringify([{ dimensionId: "dim_condition", optionId: "opt_near_mint" }]),
      25,
    ]);
  });

  it("filters items with listings or submitted offers", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      marketActivity: "any",
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(listCall?.sql).toContain("FROM discovery_market_listings AS listing");
    expectBuyerVisibleListingPredicate(listCall?.sql);
    expect(listCall?.sql).toContain("FROM discovery_offer_demand_matches AS offer");
    expect(listCall?.sql).toContain("offer.status = 'submitted'");
    expect(listCall?.values).toEqual(["active", 25]);
  });

  it("counts dimension facet values by matching listed items when listings are selected", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes("AS summaries")) {
          return {
            rows: [
              {
                kind: "dimension",
                id: "dim_condition",
                label: "Condition",
                coverage: 2,
                distinct_count: 2,
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        if (sql.includes("market_counts AS")) {
          return {
            rows: [
              { option_id: "opt_near_mint", label: "Near Mint", count: 9 },
              { option_id: "opt_mint", label: "Mint", count: 3 },
            ] as Row[],
            rowCount: 2,
          };
        }

        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    const result = await searchDiscoveryItems(db, {
      marketActivity: "listings",
      dimensionFilters: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
      limit: 24,
    });

    const facetValueCall = calls.find((call) => call.sql.includes("market_counts AS"));
    expect(facetValueCall?.sql).toContain("FROM discovery_market_listings AS listing");
    expectBuyerVisibleListingPredicate(facetValueCall?.sql);
    expect(facetValueCall?.sql).toContain(
      "COUNT(DISTINCT activity_id) FILTER (WHERE price_amount IS NOT NULL)::integer AS listing_count",
    );
    expect(facetValueCall?.sql).toContain("jsonb_array_elements(activity.selected_options)");
    expect(facetValueCall?.sql).toContain("COALESCE(market_counts.count, 0)::integer AS count");
    expect(facetValueCall?.sql).toContain("WHERE selected OR (count > 0 AND facet_rank <= 50)");
    expect(facetValueCall?.values).toEqual(["active", "dim_condition", ["opt_near_mint"]]);
    expect(result.facets[0]?.values).toEqual([
      { id: "opt_near_mint", label: "Near Mint", count: 9, selected: true },
      { id: "opt_mint", label: "Mint", count: 3, selected: false },
    ]);
  });

  it("combines listing and offer rows for any market activity dimension counts", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes("AS summaries")) {
          return {
            rows: [
              {
                kind: "dimension",
                id: "dim_condition",
                label: "Condition",
                coverage: 2,
                distinct_count: 2,
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        if (sql.includes("market_counts AS")) {
          return {
            rows: [{ option_id: "opt_near_mint", label: "Near Mint", count: 12 }] as Row[],
            rowCount: 1,
          };
        }

        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    await searchDiscoveryItems(db, {
      marketActivity: "any",
      limit: 24,
    });

    const facetValueCall = calls.find((call) => call.sql.includes("market_counts AS"));
    expect(facetValueCall?.sql).toContain("FROM discovery_market_listings AS listing");
    expectBuyerVisibleListingPredicate(facetValueCall?.sql);
    expect(facetValueCall?.sql).toContain("UNION ALL");
    expect(facetValueCall?.sql).toContain("FROM discovery_offer_demand_matches AS offer");
    expect(facetValueCall?.sql).toContain("offer.status = 'submitted'");
    expect(facetValueCall?.values).toEqual(["active", "dim_condition", []]);
  });

  it("orders field facet values with semantic sort metadata before count fallback", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes("AS summaries")) {
          return {
            rows: [
              {
                kind: "field",
                id: "fld_seed_release_year",
                label: "Release Year",
                coverage: 3,
                distinct_count: 3,
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    await searchDiscoveryItems(db, {
      fieldFilters: [{ fieldId: "fld_seed_release_year", value: "2024" }],
      limit: 24,
    });

    const facetValueCall = calls.find((call) => call.sql.includes("facet.value->>'sortKind'"));
    expect(facetValueCall?.sql).toContain("CASE WHEN sort_kind = 'date-desc' THEN sort_value END DESC NULLS LAST");
    expect(facetValueCall?.sql).toContain("CASE WHEN sort_kind = 'number-desc' THEN sort_number END DESC NULLS LAST");
    expect(facetValueCall?.sql).toContain("ROW_NUMBER() OVER (ORDER BY selected DESC");
    expect(facetValueCall?.sql).toContain("WHERE selected OR facet_rank <= 50");
    expect(facetValueCall?.sql).toContain("ORDER BY selected DESC");
    expect(facetValueCall?.values.slice(-2)).toEqual(["fld_seed_release_year", ["2024"]]);
  });

  it("orders dimension facet values by value kind, numeric value, and display order", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes("AS summaries")) {
          return {
            rows: [
              {
                kind: "dimension",
                id: "dim_seed_grade",
                label: "Grade",
                coverage: 4,
                distinct_count: 4,
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    await searchDiscoveryItems(db, {
      dimensionFilters: [{ dimensionId: "dim_seed_grade", optionId: "chc_seed_grade_poor_1" }],
      limit: 24,
    });

    const facetValueCall = calls.find((call) => call.sql.includes("facet.value->>'valueKind'"));
    expect(facetValueCall?.sql).toContain("CASE WHEN value_kind = 'numeric' THEN numeric_value END DESC NULLS LAST");
    expect(facetValueCall?.sql).toContain(
      "CASE WHEN value_kind IN ('ordered', 'numeric') THEN display_order END ASC NULLS LAST",
    );
    expect(facetValueCall?.sql).toContain("ROW_NUMBER() OVER (ORDER BY selected DESC");
    expect(facetValueCall?.sql).toContain("WHERE selected OR facet_rank <= 50");
    expect(facetValueCall?.sql).toContain("ORDER BY selected DESC");
    expect(facetValueCall?.values.slice(-2)).toEqual(["dim_seed_grade", ["chc_seed_grade_poor_1"]]);
  });
});

describe("searchDiscoveryItems facets", () => {
  it.each(["offers", "any", "listings", undefined] as const)(
    "prospective variant facet counts bind independent selected supply requirements (%s)",
    async (marketActivity) => {
      const { db: capturingDb, calls } = createCapturingDb();
      const db: PgQueryable = {
        query: async <Row>(sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("AS summaries")) {
            calls.push({ sql, values });
            return {
              rows: [{ kind: "dimension", id: "finish", label: "Finish", coverage: 1, distinct_count: 2 }] as Row[],
              rowCount: 1,
            };
          }
          return capturingDb.query<Row>(sql, values);
        },
      };
      await searchDiscoveryItems(db, {
        dimensionFilters: [
          { dimensionId: "finish", optionId: "foil" },
          { dimensionId: "condition", optionId: "mint" },
        ],
        priceMin: "10",
        priceMax: "30",
        inStock: true,
        marketActivity,
      });
      const facet = calls.find(({ sql }) => sql.includes("option_market AS"))!;
      expect(facet.sql).toContain("market.visible_quantity > 0");
      expect(facet.sql).toContain("market.lowest_price_amount >=");
      expect(facet.sql).toContain("market.lowest_price_amount <=");
      expect(facet.sql).toContain("COUNT(DISTINCT price_currency_code) = 1");
      expect(facet.sql).toContain("catalog_options AS MATERIALIZED");
      expect(facet.values).toContain(JSON.stringify([{ dimensionId: "condition", optionId: "mint" }]));
      expect(facet.values).not.toContain(JSON.stringify([{ dimensionId: "finish", optionId: "foil" }]));
      expect(facet.values.slice(-2)).toEqual(["10", "30"]);
      if (marketActivity === "offers")
        expect(facet.sql).toContain("WHERE market.visible_quantity > 0 AND market.lowest_price_amount");
      for (const call of calls) {
        const indices = [...call.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
        expect(Math.max(...indices)).toBe(call.values.length);
      }
    },
  );
  it("starts facet-value queries concurrently", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstQueryStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const summaryRows = [
      { kind: "field", id: "field_one", label: "Field one", coverage: 2, distinct_count: 2 },
      { kind: "field", id: "field_two", label: "Field two", coverage: 1, distinct_count: 1 },
    ] as const;
    const db = {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("AS summaries")) {
          return { rows: summaryRows as readonly unknown[] as T[] };
        }

        if (sql.includes("facet.value->>'fieldId'")) {
          const fieldId = String(values.at(-2));
          started.push(fieldId);
          if (fieldId === "field_one") {
            firstStarted?.();
            return await new Promise<{ rows: T[] }>((resolve) => {
              releaseFirst = () => resolve({ rows: [] });
            });
          }

          return { rows: [] as T[] };
        }

        return { rows: [] as T[] };
      },
    } as PgQueryable;

    const search = searchDiscoveryItems(db);
    await firstQueryStarted;
    const startedBeforeFirstCompleted = [...started];
    releaseFirst?.();
    await search;

    expect(startedBeforeFirstCompleted).toEqual(["field_one", "field_two"]);
  });

  it("returns a larger bounded facet option set and keeps selected values selected", async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const responses: { rows: readonly unknown[] }[] = [
      { rows: [] },
      {
        rows: [
          {
            kind: "field",
            id: "field_rarity",
            label: "Rarity",
            coverage: 12,
            distinct_count: 12,
          },
        ],
      },
      {
        rows: [
          {
            value: "rare",
            label: "Rare",
            count: 3,
          },
        ],
      },
      { rows: [] },
    ];
    const db = {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        const response = responses.shift();

        if (!response) {
          throw new Error(`Unexpected query: ${sql}`);
        }

        return response as { rows: T[] };
      },
    } as PgQueryable;

    const result = await searchDiscoveryItems(db, {
      fieldFilters: [{ fieldId: "field_rarity", value: "rare" }],
    });

    const valueQuery = calls.find((call) => call.sql.includes("BOOL_OR(facet.value->>'value' = ANY"));
    expect(valueQuery?.sql).toContain("BOOL_OR(facet.value->>'value' = ANY($3::text[])) AS selected");
    expect(valueQuery?.sql).toContain("WHERE selected OR facet_rank <= 50");
    expect(valueQuery?.sql).toContain("ORDER BY selected DESC");
    expect(valueQuery?.values).toEqual(["active", "field_rarity", ["rare"]]);
    expect(result.facets[0]?.values).toEqual([
      {
        id: "rare",
        label: "Rare",
        count: 3,
        selected: true,
      },
    ]);
  });

  it("keeps rich reference facets visible when generic facets have higher raw coverage", async () => {
    const summaryRows = [
      { kind: "field", id: "fld_seed_card_name", label: "Card Name", coverage: 100, distinct_count: 20 },
      { kind: "field", id: "fld_seed_card_number", label: "Card Number", coverage: 100, distinct_count: 20 },
      { kind: "field", id: "fld_seed_card_illustrator", label: "Card Illustrator", coverage: 100, distinct_count: 20 },
      { kind: "field", id: "fld_seed_pack_count", label: "Pack Count", coverage: 100, distinct_count: 20 },
      { kind: "field", id: "fld_seed_language", label: "Language", coverage: 100, distinct_count: 20 },
      { kind: "field", id: "fld_seed_sku", label: "SKU", coverage: 100, distinct_count: 20 },
      { kind: "field", id: "fld_seed_source", label: "Source", coverage: 100, distinct_count: 20 },
      { kind: "reference", id: "expansion", label: "Expansion", coverage: 50, distinct_count: 4 },
      { kind: "reference", id: "series", label: "Series", coverage: 50, distinct_count: 2 },
      { kind: "reference", id: "manufacturer", label: "Manufacturer", coverage: 50, distinct_count: 1 },
      { kind: "dimension", id: "dim_seed_condition", label: "Condition", coverage: 90, distinct_count: 7 },
      { kind: "field", id: "fld_seed_rarity", label: "Rarity", coverage: 80, distinct_count: 6 },
    ] as const;
    const db = {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("AS summaries")) {
          return { rows: summaryRows as readonly unknown[] as T[] };
        }

        if (sql.includes("facet.value->>'fieldId'")) {
          const fieldId = values.at(-2);
          return {
            rows: [
              {
                value: `${fieldId}_value`,
                label: `${fieldId} value`,
                count: 1,
              },
            ] as T[],
          };
        }

        if (sql.includes("facet.value->>'typeKey'")) {
          const typeKey = values.at(-2);
          return {
            rows: [
              {
                reference_id: `${typeKey}_reference`,
                label: `${typeKey} reference`,
                count: 1,
              },
            ] as T[],
          };
        }

        if (sql.includes("facet.value->>'dimensionId'")) {
          const dimensionId = values.at(-2);
          return {
            rows: [
              {
                option_id: `${dimensionId}_option`,
                label: `${dimensionId} option`,
                count: 1,
              },
            ] as T[],
          };
        }

        return { rows: [] as T[] };
      },
    } as PgQueryable;

    const result = await searchDiscoveryItems(db);
    const facetIds = result.facets.map((facet) => facet.id);

    expect(facetIds).toContain("expansion");
    expect(facetIds).toContain("series");
    expect(facetIds).toContain("manufacturer");
    expect(facetIds).not.toContain("fld_seed_source");
  });
});

describe("previewBulkAddSearchResults", () => {
  it("preview retains selected dimensions and selected stock/price constraints", async () => {
    const { db, calls } = createCapturingDb();
    const dimensionFilters = [{ dimensionId: "finish", optionId: "foil" }];
    await previewBulkAddSearchResults(db, { dimensionFilters, inStock: true, priceMin: "10", priceMax: "30" });
    const list = findListCall(calls)!;
    expect(list.sql).toContain("selected_market.lowest_price_amount >=");
    expect(list.sql).toContain("selected_market.lowest_price_amount <=");
    expect(list.sql).toContain("selected_market.total_visible_quantity > 0");
    expect(list.values).toContain(JSON.stringify(dimensionFilters));
  });
  it("performs no facet work", async () => {
    const { db, calls } = createCapturingDb();

    await previewBulkAddSearchResults(db, { search: "Charizard" });

    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.sql.includes("AS summaries"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("jsonb_array_elements"))).toBe(false);
  });
});

describe("searchDiscoveryItems input hardening", () => {
  it("expands reviewed vocabulary as original OR whole phrase, retaining required terms and original exact tier", async () => {
    const { db, calls } = createCapturingDb();
    await searchDiscoveryItems(db, { search: "pkmn ETB zard missing" }, { loadFacets: false });
    const list = findListCall(calls)!;
    expect(list.sql).toContain("to_tsquery('english', $2)");
    expect(list.sql).toContain("to_tsquery('simple', $3)");
    expect(list.values.slice(1, 4)).toEqual([
      "(pkmn | (pokemon)) & (ETB | (elite <-> trainer <-> box)) & (zard | (charizard)) & missing",
      "(pkmn | (pokemon)) & (ETB | (elite <-> trainer <-> box)) & (zard | (charizard)) & missing",
      "pkmn ETB zard missing",
    ]);
    expect(list.sql).not.toContain("pkmn");
    // Bypass mutant: globally OR-relaxing the required groups loses this discriminator.
    expect(String(list.values[1]).replaceAll(" & ", " | ")).not.toBe(list.values[1]);
  });

  it("batches served-code candidates once and reuses membership across facets and counts", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        const rows = sql.includes("unnest($1::text[])") ? [{ set_code: "zard" }] : [];
        return { rows: rows as Row[], rowCount: rows.length };
      },
    };
    await searchDiscoveryItems(db, { search: "zard 4/102 zard 136a TSP 136a charzard 4/102" });
    const lookups = calls.filter(({ sql }) => sql.includes("unnest($1::text[])"));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.values).toEqual([["zard", "tsp", "charzard"]]);
    expect(lookups[0]?.sql).toContain("EXISTS");
    expect(lookups[0]?.sql).toContain("item.set_code = candidate.set_code");
    expect(findListCall(calls)?.values[1]).toBe("zard & 4/102 & zard & 136a & TSP & 136a & charzard & 4/102");
  });

  it("does not protect an absent alphabetic nickname merely because it precedes a collector number", async () => {
    const { db, calls } = createCapturingDb();
    await searchDiscoveryItems(db, { search: "zard 4/102" }, { loadFacets: false });
    expect(findListCall(calls)?.values.slice(1, 3)).toEqual([
      "(zard | (charizard)) & 4/102",
      "(zard | (charizard)) & (4 <-> 102)",
    ]);
  });

  it("folds diacritics in both full-text query inputs", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, { search: "Pokémon", limit: 24 }, { loadFacets: false, loadMarketSummaries: false });

    expect(calls[0]?.values).toEqual(["active", "Pokemon", "Pokemon", "Pokémon", 25]);
  });

  it.each([
    ["maximum Latin query", "a".repeat(256)],
    ["maximum CJK query", "検索".repeat(128)],
    ["tsquery metacharacters", `Charizard' & :* "quoted"`],
  ])("keeps %s parameterized and well formed", async (_label, search) => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, { search, limit: 24 }, { loadFacets: false, loadMarketSummaries: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("plainto_tsquery('english', $2)");
    expect(calls[0]?.sql).toContain("plainto_tsquery('simple', $3)");
    expect(calls[0]?.sql).not.toContain(search);
    expect(calls[0]?.values).toEqual(["active", search, buildSimpleSearchQuery(search), search, 25]);
  });
});

describe("searchDiscoveryItemsByNaturalKey", () => {
  it("keeps the structured natural-key indexes aligned with the ledger", () => {
    const migration = discoverySearchSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260710_discovery_search_natural_key_indexes",
    );

    expect(discoverySearchSchemaSql).toContain("set_code text NULL");
    expect(discoverySearchSchemaSql).toContain("card_number text NULL");
    expect(discoverySearchSchemaSql).not.toContain("discovery_search_items_set_code_card_number_idx");
    expect(migration?.statements).toEqual([
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_set_code_card_number_idx",
      ),
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_blueprint_set_code_card_number_idx",
      ),
    ]);
    expect(migration?.statements[0]).toContain("ON discovery_search_items (set_code, card_number)");
    expect(migration?.statements[1]).toContain("ON discovery_search_items (blueprint_id, set_code, card_number)");
  });

  it("matches on the exact normalized tuple without ANDing the raw structured query text", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItemsByNaturalKey(db, { setCode: "sv04", cardNumber: "123" }, { search: "SV04 123/182" });

    const listCall = calls.find((call) => call.sql.includes("FROM discovery_search_items"));
    expect(listCall?.sql).toContain("WHERE status = $1 AND set_code = $2 AND card_number = $3");
    expect(listCall?.sql).not.toContain("plainto_tsquery");
    expect(listCall?.values).toEqual(["active", "sv04", "123", 50]);
  });

  it("composes with ordinary filters (category, language, blueprint)", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItemsByNaturalKey(
      db,
      { setCode: "op01", cardNumber: "1" },
      { category: "one-piece", language: "en", blueprintId: "bpr_one_piece_card_print", limit: 10 },
    );

    const listCall = calls.find((call) => call.sql.includes("FROM discovery_search_items"));
    expect(listCall?.sql).toContain("category_names");
    expect(listCall?.sql).toContain("language_code");
    expect(listCall?.sql).toContain("blueprint_id");
    expect(listCall?.sql).toContain("ORDER BY title ASC, catalog_item_id ASC");
    expect(listCall?.values).toEqual([
      "active",
      JSON.stringify(["one-piece"]),
      "bpr_one_piece_card_print",
      "en",
      "op01",
      "1",
      10,
    ]);
  });

  it("returns an empty result with no facets and no market lookup when nothing matches", async () => {
    const { db } = createCapturingDb();

    const result = await searchDiscoveryItemsByNaturalKey(db, { setCode: "zzz", cardNumber: "999" });

    expect(result).toEqual({ items: [], facets: [], category_counts: [], total: 0, nextCursor: null });
  });
});
