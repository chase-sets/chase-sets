import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listCatalogItems } from "./queries";

describe("catalog item read-model queries", () => {
  it("clamps and parameterizes catalog item list pagination", async () => {
    const db = queryableSequence([[{ count: "1" }], [{ catalog_item_id: "cat_1" }]]);

    const result = await listCatalogItems(db, {
      status: "active",
      search: "charizard",
      limit: 9e15,
      offset: -5,
    });

    expect(result).toEqual({ items: [{ catalog_item_id: "cat_1" }], total: 1 });
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $3 OFFSET $4"), [
      "active",
      "%charizard%",
      500,
      0,
    ]);
  });
});

function queryableSequence(results: readonly (readonly Record<string, unknown>[])[]): PgQueryable {
  let index = 0;

  return {
    query: vi.fn(async () => {
      const rows = results[Math.min(index, results.length - 1)] ?? [];
      index += 1;
      return {
        rows: [...rows],
        rowCount: rows.length,
      };
    }),
  };
}
