import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
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
});
