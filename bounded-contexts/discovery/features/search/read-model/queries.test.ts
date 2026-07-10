import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { searchDiscoveryItems, searchDiscoveryItemsByNaturalKey, searchDiscoverySemanticItems } from "./queries";
import { discoverySearchSchemaMigrations, discoverySearchSchemaSql } from "./schema";

function encodeCursor(input: { id: string; title: string; updatedAt: string; rank?: number; baseMatch?: boolean }) {
  return Buffer.from(
    JSON.stringify({
      id: input.id,
      title: input.title,
      updatedAt: input.updatedAt,
      rank: input.rank ?? 0,
      baseMatch: input.baseMatch ?? false,
    }),
    "utf8",
  ).toString("base64url");
}

function createCapturingDb() {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [] as Row[], rowCount: 0 };
    },
  };

  return { db, calls };
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

  it("uses a ledgered halfvec reshape and concurrent HNSW index", () => {
    const migration = discoverySearchSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260710_discovery_search_voyage_embeddings",
    );

    expect(discoverySearchSchemaSql).toContain("search_embedding halfvec(1024)");
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

  it("applies a rank cursor for relevance searches", async () => {
    const { db, calls } = createCapturingDb();
    const cursor = encodeCursor({
      id: "cat_002",
      title: "Bulbasaur",
      updatedAt: "2026-05-16T00:00:00.000Z",
      rank: 0.75,
      baseMatch: true,
    });

    await searchDiscoveryItems(db, {
      search: "pokemon",
      sort: "relevance",
      cursor,
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(listCall?.sql).toContain("(ts_rank(search_text");
    expect(listCall?.sql).toContain("discovery_search_product_contents AS content");
    expect(listCall?.sql).toContain("* 0.20");
    expect(listCall?.sql).toContain("search_base_match");
    expect(listCall?.sql).toContain(", title, catalog_item_id) <");
    expect(listCall?.sql).toContain("ORDER BY (search_text @@");
    expect(listCall?.sql).toContain("DESC, title ASC, catalog_item_id ASC");
    expect(listCall?.sql).not.toContain("OFFSET");
    expect(listCall?.values.slice(-5)).toEqual([1, 0.75, "Bulbasaur", "cat_002", 25]);
  });

  it("orders exact item matches ahead of content-only container matches", async () => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, {
      search: "Charizard",
      sort: "relevance",
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(listCall?.sql).toContain("OR EXISTS");
    expect(listCall?.sql).toContain("FROM discovery_search_product_contents AS content");
    expect(listCall?.sql).toContain("INNER JOIN discovery_search_catalog_items AS contained_item");
    expect(listCall?.sql).toContain("contained_item.status = 'active'");
    expect(listCall?.sql).toContain("content.container_catalog_item_id = discovery_search_items.catalog_item_id");
    expect(listCall?.sql).toContain("content.content_type_search_weight::real");
    expect(listCall?.sql).toContain("* 0.20");
    expect(listCall?.sql).toContain(
      "ORDER BY (search_text @@ plainto_tsquery('english', $2) OR search_text_simple @@ plainto_tsquery('simple', $3)) DESC",
    );
    expect(listCall?.values).toEqual(["active", "Charizard", "Charizard", 25]);
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
    expect(facetValueCall?.sql).toContain("COUNT(DISTINCT activity.activity_id)::integer AS count");
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

    const valueQuery = calls.at(-1);
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

    expect(result).toEqual({ items: [], facets: [], total: 0, nextCursor: null });
  });
});
