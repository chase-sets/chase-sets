import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getCatalogItemByGtin, listCatalogItems } from "./queries";

describe("catalog item read-model queries", () => {
  it("clamps and parameterizes catalog item list pagination", async () => {
    const db = queryableSequence([[{ count: "1" }], [{ catalog_item_id: "cat_1" }]]);

    const result = await listCatalogItems(db, {
      status: "active",
      search: "charizard_%",
      limit: 9e15,
      offset: -5,
    });

    expect(result).toEqual({ items: [{ catalog_item_id: "cat_1" }], total: 1 });
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain("ILIKE $2 ESCAPE '\\'");
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $3 OFFSET $4"), [
      "active",
      "%charizard\\_\\%%",
      500,
      0,
    ]);
  });

  it("normalizes the input GTIN before querying the lookup table", async () => {
    const db = queryableSequence([[{ gtin: "00307418529636", catalog_item_id: "cat_1", product_form: null }]]);

    const result = await getCatalogItemByGtin(db, "3074-1852-9636");

    expect(result).toEqual({ gtin: "00307418529636", catalog_item_id: "cat_1", product_form: null });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FROM catalog_item_gtins AS link"), [
      "00307418529636",
    ]);
  });

  it("returns null without querying when the input does not normalize to a valid GTIN", async () => {
    const db = queryableSequence([[]]);

    const result = await getCatalogItemByGtin(db, "not-a-barcode");

    expect(result).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns null when no item is linked to the normalized GTIN", async () => {
    const db = queryableSequence([[]]);

    const result = await getCatalogItemByGtin(db, "307418529636");

    expect(result).toBeNull();
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
