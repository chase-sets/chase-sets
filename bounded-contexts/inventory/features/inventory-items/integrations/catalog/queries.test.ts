import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { getInventoryCatalogItemByGtin } from "./queries";

const now = "2026-06-23T00:00:00.000Z";
describe("inventory catalog item queries", () => {
  it("normalizes the input GTIN before querying the mirrored lookup table", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return {
          rows: [{ gtin: "00307418529636", catalog_item_id: "cat_1", product_form: "booster-box", updated_at: now }],
          rowCount: 1,
        } as PgQueryResult<Row>;
      },
    };

    const result = await getInventoryCatalogItemByGtin(db, "3074-1852-9636");

    expect(result).toEqual({
      gtin: "00307418529636",
      catalog_item_id: "cat_1",
      product_form: "booster-box",
      updated_at: now,
    });
    expect(calls[0]?.sql).toContain("FROM inventory_catalog_gtins");
    expect(calls[0]?.values).toEqual(["00307418529636"]);
  });

  it("returns null without querying when the input does not normalize to a valid GTIN", async () => {
    const db: PgQueryable = {
      query: async () => {
        throw new Error("should not query for an invalid GTIN");
      },
    };

    const result = await getInventoryCatalogItemByGtin(db, "not-a-barcode");

    expect(result).toBeNull();
  });
});
