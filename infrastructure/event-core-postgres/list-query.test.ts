import { describe, expect, it } from "vitest";
import type { PgQueryable } from "./types";
import { buildFilteredQuery, executeListQuery } from "./list-query";

describe("list query helpers", () => {
  it("builds filtered count and list SQL with stable parameter indexes", () => {
    const query = buildFilteredQuery(
      "catalog_fields",
      { status: "active", search: "name", limit: 25, offset: 50 },
      ["key", "name"],
      "key ASC",
      ["value_type = $1"],
      ["text"],
    );

    expect(query).toEqual({
      countSql:
        "SELECT COUNT(*) as count FROM catalog_fields WHERE value_type = $1 AND status = $2 AND (key ILIKE $3 OR name ILIKE $3)",
      listSql:
        "SELECT * FROM catalog_fields WHERE value_type = $1 AND status = $2 AND (key ILIKE $3 OR name ILIKE $3) ORDER BY key ASC LIMIT $4 OFFSET $5",
      values: ["text", "active", "%name%"],
      countValues: ["text", "active", "%name%"],
      listValues: ["text", "active", "%name%", 25, 50],
    });
  });

  it("defaults non-numeric and malicious pagination while keeping SQL parameterized", () => {
    const query = buildFilteredQuery(
      "catalog_fields",
      { limit: "1; DROP TABLE catalog_fields", offset: Number.NaN },
      ["key"],
      "key ASC",
    );

    expect(query.listSql).toBe("SELECT * FROM catalog_fields  ORDER BY key ASC LIMIT $1 OFFSET $2");
    expect(query.listValues).toEqual([50, 0]);
  });

  it("clamps oversized and negative pagination inputs", () => {
    const oversized = buildFilteredQuery("catalog_fields", { limit: 100_000, offset: 100_000 }, ["key"], "key ASC");
    const negative = buildFilteredQuery("catalog_fields", { limit: -25, offset: -10 }, ["key"], "key ASC");

    expect(oversized.listValues).toEqual([500, 10_000]);
    expect(negative.listValues).toEqual([1, 0]);
  });

  it("executes count and list SQL against the same parameters", async () => {
    type Row = Readonly<{ id: string }>;
    const countSql = "SELECT COUNT(*) as count FROM catalog_fields";
    const listSql = "SELECT * FROM catalog_fields ORDER BY key ASC LIMIT $2 OFFSET $3";
    const countValues = ["active"];
    const listValues = ["active", 25, 50];
    const calls: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
    const db: PgQueryable = {
      query: async <QueryRow>(sql: string, queryValues: readonly unknown[] = []) => {
        calls.push({ sql, values: queryValues });

        if (sql === countSql) {
          return { rows: [{ count: "2" } as QueryRow], rowCount: 1 };
        }

        if (sql === listSql) {
          return { rows: [{ id: "field_1" }, { id: "field_2" }] as QueryRow[], rowCount: 2 };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };

    await expect(executeListQuery<Row>(db, countSql, listSql, countValues, listValues)).resolves.toEqual({
      items: [{ id: "field_1" }, { id: "field_2" }],
      total: 2,
    });
    expect(calls).toEqual([
      { sql: countSql, values: countValues },
      { sql: listSql, values: listValues },
    ]);
  });
});
