import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listPurchases, listSales } from "./queries";

describe("ordering order read-model queries", () => {
  it("computes order-list line stats per visible order instead of aggregating the full line table", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async <T>(sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params });
        return {
          rows: sql.includes("SELECT COUNT(*) AS count") ? ([{ count: "0" }] as T[]) : ([] as T[]),
        };
      },
    } satisfies PgQueryable;

    await listPurchases(db, { buyerAccountId: "acct_buyer", limit: 50, offset: 0 });
    await listSales(db, { sellerAccountId: "acct_seller", limit: 50, offset: 0 });

    const listQueries = queries
      .map((query) => query.sql)
      .filter((sql) => sql.includes("FROM ordering_order_pages AS page"));

    expect(listQueries).toHaveLength(2);
    for (const sql of listQueries) {
      expect(sql).toContain("LEFT JOIN LATERAL");
      expect(sql).toContain("WHERE line.order_id = page.order_id");
      expect(sql).not.toContain("GROUP BY order_id");
      expect(sql).not.toContain("FROM ordering_order_line_pages\n    GROUP BY order_id");
    }
  });
});
