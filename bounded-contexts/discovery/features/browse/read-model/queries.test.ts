import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { searchDiscoveryItems as searchDiscoveryItemsContract } from "../../search/read-model/queries";

const { loadReferenceRecordMap, searchDiscoveryItems } = vi.hoisted(() => ({
  loadReferenceRecordMap: vi.fn(async () => new Map()),
  searchDiscoveryItems: vi.fn<typeof searchDiscoveryItemsContract>(async () => ({ items: [], total: 3 })),
}));

vi.mock("../../../support/item-support/reference-records", async (importOriginal) => ({
  ...(await importOriginal()),
  loadReferenceRecordMap,
}));
vi.mock("../../search/read-model/queries", async (importOriginal) => ({
  ...(await importOriginal()),
  searchDiscoveryItems,
}));

import { getDiscoveryBrowseSetPageBySlug } from "./queries";

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

describe("getDiscoveryBrowseSetPageBySlug", () => {
  beforeEach(() => {
    loadReferenceRecordMap.mockClear();
    searchDiscoveryItems.mockClear();
    searchDiscoveryItems.mockResolvedValue({
      items: [
        {
          catalog_item_id: "item_foreign_printing",
          slug: "base-set-charizard-foreign-printing",
          language_code: "fr",
          title_i18n: null,
          title: "Charizard (French printing)",
          subtitle_i18n: null,
          subtitle: null,
          display_badges: [],
          description_i18n: null,
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
          market_summary: null,
          updated_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      total: 3,
    });
  });

  it("resolves by slug or slug redirect, restricted to set-like reference types", async () => {
    const db = queryDbSequence([[]]);

    const result = await getDiscoveryBrowseSetPageBySlug(db, "surging-sparks");

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.sql).toContain("discovery_search_catalog_reference_records");
    expect(db.queries[0]?.sql).toContain("discovery_slug_redirects");
    expect(db.queries[0]?.sql).toContain("entity_kind = 'reference-record'");
    expect(db.queries[0]?.sql).toContain("record.type_key = ANY($2::text[])");
    expect(db.queries[0]?.values).toEqual(["surging-sparks", ["set", "expansion"]]);
  });

  it("does not resolve a set that has not been published, and issues no further queries", async () => {
    const db = queryDbSequence([
      [
        {
          reference_record_id: "ref_1",
          type_key: "expansion",
          key: "surging-sparks",
          slug: "surging-sparks",
          name: "Surging Sparks",
          attributes: {},
          status: "draft",
          updated_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    ]);

    const result = await getDiscoveryBrowseSetPageBySlug(db, "surging-sparks");

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(1);
  });

  it.each([
    ["number", { "card-count": 102 }, 102],
    ["trimmed digit string", { "card-count": " 102 " }, 102],
    ["one", { "card-count": 1 }, 1],
    ["printed count does not override card count", { "printed-card-count": 100, "card-count": 110 }, 110],
    ["invalid printed count does not override card count", { "printed-card-count": 0, "card-count": 102 }, 102],
    ["printed count does not supply a missing card count", { "printed-card-count": 110 }, null],
    [
      "printed count does not replace an invalid card count",
      { "printed-card-count": 110, "card-count": "invalid" },
      null,
    ],
    ["unsafe number", { "card-count": Number.MAX_SAFE_INTEGER + 1 }, null],
    ["unsafe string", { "card-count": "9007199254740992" }, null],
    ["invalid card count", { "card-count": 0 }, null],
    ["negative count", { "card-count": -1 }, null],
    ["fractional count", { "card-count": 1.5 }, null],
    ["non-finite count", { "card-count": Number.POSITIVE_INFINITY }, null],
    ["blank string", { "card-count": " " }, null],
    ["nonnumeric string", { "card-count": "abc" }, null],
    ["partly numeric string", { "card-count": "102 cards" }, null],
    ["boolean", { "card-count": true }, null],
    ["array", { "card-count": [102] }, null],
    ["object", { "card-count": { value: 102 } }, null],
    ["missing candidates", {}, null],
    ["null attributes", null, null],
    ["array attributes", [], null],
    ["string attributes", "card-count: 102", null],
  ])("returns the expected reference total for %s", async (_label, attributes, expected) => {
    const db = queryDbSequence([
      [
        {
          reference_record_id: "ref_1",
          type_key: "expansion",
          key: "base-set",
          slug: "base-set",
          name: "Base Set",
          attributes,
          status: "active",
          updated_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    ]);

    const result = await getDiscoveryBrowseSetPageBySlug(db, "base-set");

    expect(result?.reference_card_count).toBe(expected);
    expect(result?.item_count).toBe(3);
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.title).toBe("Charizard (French printing)");
  });
});
