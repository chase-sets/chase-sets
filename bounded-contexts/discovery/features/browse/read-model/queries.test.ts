import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const { loadReferenceRecordMap, searchDiscoveryItems } = vi.hoisted(() => ({
  loadReferenceRecordMap: vi.fn(async () => new Map()),
  searchDiscoveryItems: vi.fn(async () => ({ items: [], total: 3 })),
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
    searchDiscoveryItems.mockResolvedValue({ items: [], total: 3 });
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
    ["numeric string", { "card-count": "102" }, 102],
    ["printed count precedence", { "printed-card-count": 110, "card-count": 102 }, 110],
    ["numeric printed count precedence", { "printed-card-count": "110", "card-count": "102" }, 110],
    ["valid printed count ignores invalid card count", { "printed-card-count": 110, "card-count": "invalid" }, 110],
    ["invalid printed count fallback", { "printed-card-count": 0, "card-count": 102 }, 102],
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
    expect(result?.items).toEqual([]);
  });
});
