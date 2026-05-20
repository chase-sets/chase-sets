import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { searchDiscoveryItems } from "./queries";

function encodeCursor(input: {
  id: string;
  title: string;
  updatedAt: string;
  rank?: number;
}) {
  return Buffer.from(JSON.stringify({
    id: input.id,
    title: input.title,
    updatedAt: input.updatedAt,
    rank: input.rank ?? 0,
  }), "utf8").toString("base64url");
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

describe("searchDiscoveryItems cursor paging", () => {
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
  ])("applies stable cursor ordering for $sort", async ({
    sort,
    cursor,
    expectedCondition,
    expectedOrder,
    expectedCursorValues,
  }) => {
    const { db, calls } = createCapturingDb();

    await searchDiscoveryItems(db, { sort, cursor, limit: 24 });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(listCall?.sql).toContain(expectedCondition);
    expect(listCall?.sql).toContain(expectedOrder);
    expect(listCall?.sql).toContain("LIMIT $4");
    expect(listCall?.sql).not.toContain("OFFSET");
    expect(listCall?.values).toEqual(["active", ...expectedCursorValues, 25]);
  });

  it("applies a rank cursor for relevance searches", async () => {
    const { db, calls } = createCapturingDb();
    const cursor = encodeCursor({
      id: "cat_002",
      title: "Bulbasaur",
      updatedAt: "2026-05-16T00:00:00.000Z",
      rank: 0.75,
    });

    await searchDiscoveryItems(db, {
      search: "pokemon",
      sort: "relevance",
      cursor,
      limit: 24,
    });

    const listCall = calls.find((call) => call.sql.includes("SELECT catalog_item_id"));
    expect(listCall?.sql).toContain("(ts_rank(search_text");
    expect(listCall?.sql).toContain(", title, catalog_item_id) <");
    expect(listCall?.sql).toContain("ORDER BY (ts_rank(search_text");
    expect(listCall?.sql).toContain("DESC, title ASC, catalog_item_id ASC");
    expect(listCall?.sql).not.toContain("OFFSET");
    expect(listCall?.values.slice(-4)).toEqual([0.75, "Bulbasaur", "cat_002", 25]);
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

  it("orders field facet values with semantic sort metadata before count fallback", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes("AS summaries")) {
          return {
            rows: [{
              kind: "field",
              id: "fld_seed_release_year",
              label: "Release Year",
              coverage: 3,
              distinct_count: 3,
            }] as Row[],
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
            rows: [{
              kind: "dimension",
              id: "dim_seed_grade",
              label: "Grade",
              coverage: 4,
              distinct_count: 4,
            }] as Row[],
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
    expect(facetValueCall?.sql).toContain("CASE WHEN value_kind IN ('ordered', 'numeric') THEN display_order END ASC NULLS LAST");
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
        rows: [{
          kind: "field",
          id: "field_rarity",
          label: "Rarity",
          coverage: 12,
          distinct_count: 12,
        }],
      },
      {
        rows: [{
          value: "rare",
          label: "Rare",
          count: 3,
        }],
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
            rows: [{
              value: `${fieldId}_value`,
              label: `${fieldId} value`,
              count: 1,
            }] as T[],
          };
        }

        if (sql.includes("facet.value->>'typeKey'")) {
          const typeKey = values.at(-2);
          return {
            rows: [{
              reference_id: `${typeKey}_reference`,
              label: `${typeKey} reference`,
              count: 1,
            }] as T[],
          };
        }

        if (sql.includes("facet.value->>'dimensionId'")) {
          const dimensionId = values.at(-2);
          return {
            rows: [{
              option_id: `${dimensionId}_option`,
              label: `${dimensionId} option`,
              count: 1,
            }] as T[],
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
