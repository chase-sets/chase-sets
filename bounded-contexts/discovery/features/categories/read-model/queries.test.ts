import { describe, expect, it } from "vitest";
import { listDiscoveryCategories } from "./queries";

describe("discovery category queries", () => {
  it("defaults to active categories and applies parent filters", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    await listDiscoveryCategories({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    }, {
      parentCategoryId: "cat_parent",
    });

    expect(calls[0]?.sql).toContain("WHERE status = $1 AND parent_category_id = $2");
    expect(calls[0]?.sql).toContain("ORDER BY display_order ASC");
    expect(calls[0]?.params).toEqual(["active", "cat_parent"]);
  });
});
