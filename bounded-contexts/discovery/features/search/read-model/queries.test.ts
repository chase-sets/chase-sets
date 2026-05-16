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
});
