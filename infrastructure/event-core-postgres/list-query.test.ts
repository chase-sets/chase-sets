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
        "SELECT * FROM catalog_fields WHERE value_type = $1 AND status = $2 AND (key ILIKE $3 OR name ILIKE $3) ORDER BY key ASC LIMIT 25 OFFSET 50",
      values: ["text", "active", "%name%"],
    });
  });

  it("executes count and list SQL against the same parameters", async () => {
    type Row = Readonly<{ id: string }>;
    const countSql = "SELECT COUNT(*) as count FROM catalog_fields";
    const listSql = "SELECT * FROM catalog_fields ORDER BY key ASC";
    const values = ["active"];
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

    await expect(executeListQuery<Row>(db, countSql, listSql, values)).resolves.toEqual({
      items: [{ id: "field_1" }, { id: "field_2" }],
      total: 2,
    });
    expect(calls).toEqual([
      { sql: countSql, values },
      { sql: listSql, values },
    ]);
  });
});
