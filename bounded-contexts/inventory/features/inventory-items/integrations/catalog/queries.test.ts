import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import {
  getInventoryCatalogItemByGtin,
  searchInventoryCatalogItems,
  type InventoryCatalogItemSnapshot,
} from "./queries";

type StoredCatalogItem = Omit<InventoryCatalogItemSnapshot, "product_schema"> &
  Readonly<{
    product_schema: unknown;
  }>;

const now = "2026-06-23T00:00:00.000Z";

class CatalogItemSearchDb implements PgQueryable {
  public readonly queries: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];

  public constructor(private readonly rows: readonly StoredCatalogItem[]) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.queries.push({ sql, values });

    if (sql.includes("to_regclass('public.inventory_catalog_items')")) {
      return { rows: [{ table_name: "inventory_catalog_items" } as Row], rowCount: 1 };
    }

    if (!sql.includes("FROM inventory_catalog_items")) {
      throw new Error(`Unexpected query: ${sql}`);
    }

    const status = String(values[0]);
    const hasSearch = values.length === 3;
    const search = hasSearch ? String(values[1]).replaceAll("%", "").toLowerCase() : "";
    const limit = Number(values[values.length - 1]);
    const matchingRows = this.rows
      .filter((row) => row.status === status)
      .filter(
        (row) =>
          search.length === 0 ||
          row.catalog_item_id.toLowerCase().includes(search) ||
          row.title.toLowerCase().includes(search) ||
          (row.subtitle ?? "").toLowerCase().includes(search),
      );
    const matches = matchingRows.slice(0, limit).map((row) => ({ ...row, total_count: String(matchingRows.length) }));

    return { rows: matches as Row[], rowCount: matches.length };
  }
}

function item(overrides: Partial<StoredCatalogItem>): StoredCatalogItem {
  return {
    catalog_item_id: "cat_1",
    language_code: "en",
    title: "Air Balloon",
    subtitle: "Scarlet & Violet",
    blueprint_id: "bp_1",
    status: "active",
    product_schema: null,
    updated_at: now,
    ...overrides,
  };
}

describe("inventory catalog item queries", () => {
  it("searches active projected catalog items by visible identity", async () => {
    const db = new CatalogItemSearchDb([
      item({ catalog_item_id: "cat_air", title: "Air Balloon", subtitle: "Trainer Item" }),
      item({ catalog_item_id: "cat_pika", title: "Pikachu", subtitle: "Jungle" }),
      item({ catalog_item_id: "cat_draft_air", title: "Air Balloon Draft", status: "draft" }),
    ]);

    const result = await searchInventoryCatalogItems(db, { search: "air", limit: 10 });

    expect(result.items).toEqual([
      expect.objectContaining({
        catalog_item_id: "cat_air",
        title: "Air Balloon",
        status: "active",
      }),
    ]);
  });

  it("escapes LIKE metacharacters in picker search text", async () => {
    const db = new CatalogItemSearchDb([]);

    await searchInventoryCatalogItems(db, { search: "air_%", limit: 10 });

    const searchQuery = db.queries.find((query) => query.sql.includes("FROM inventory_catalog_items"));
    expect(searchQuery?.sql).toContain("ILIKE $2 ESCAPE '\\'");
    expect(searchQuery?.values).toEqual(["active", "%air\\_\\%%", 10]);
  });

  it("bounds result limits for picker requests", async () => {
    const db = new CatalogItemSearchDb(
      Array.from({ length: 30 }, (_, index) =>
        item({ catalog_item_id: `cat_${index + 1}`, title: `Catalog item ${index + 1}` }),
      ),
    );

    const result = await searchInventoryCatalogItems(db, { limit: 1000 });

    expect(result.items).toHaveLength(25);
    expect(result.total).toBe(30);
  });

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
