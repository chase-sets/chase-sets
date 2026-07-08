import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { listInventoryItems, listNativeInventoryExportItems } from "./queries";

describe("inventory item read model queries", () => {
  it("lists account inventory through a single paged query before aggregating active holds", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        calls.push({ sql, values });

        if (sql.includes("WITH matching_items AS")) {
          return {
            rows: [
              {
                total_count: 12,
                item_id: "inv_1",
                account_id: "acc_1",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::condition:near_mint",
                selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
                graded_card: null,
                storage_location_id: "loc_1",
                storage_location_name: "Main shelf",
                ship_from_code: "HOME",
                ship_from_address: {
                  name: "Seller",
                  line1: "1 Main",
                  city: "Chicago",
                  state: "IL",
                  postalCode: "60601",
                  country: "US",
                },
                total_quantity: 5,
                held_quantity: 2,
                available_quantity: 3,
                acquisition_cost_amount: null,
                created_at: "2026-07-01T00:00:00.000Z",
                updated_at: "2026-07-02T00:00:00.000Z",
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        if (sql.includes("to_regclass('public.inventory_catalog_items')")) {
          return { rows: [{ table_name: null } as Row], rowCount: 1 };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await listInventoryItems(db, { accountId: "acc_1", limit: 100, offset: 0 });
    const listQuery = calls.find((call) => call.sql.includes("WITH matching_items AS"));

    expect(result.total).toBe(12);
    expect(result.items).toHaveLength(1);
    expect(listQuery?.values).toEqual(["acc_1", 100, 0, null, null, null, null]);
    expect(listQuery?.sql).toContain("COUNT(*) OVER()::integer AS total_count");
    expect(listQuery?.sql).toContain("FROM inventory_items");
    expect(listQuery?.sql).toContain("WHERE item.account_id = $1");
    expect(listQuery?.sql).toContain("($4::text IS NULL OR item.catalog_catalog_item_id = $4)");
    expect(listQuery?.sql).toContain("($5::text IS NULL OR item.product_id = $5)");
    expect(listQuery?.sql).toContain("($6::text IS NULL OR item.storage_location_id = $6)");
    expect(listQuery?.sql).toContain("$7::text IS NULL");
    expect(listQuery?.sql).toContain("LIMIT $2");
    expect(listQuery?.sql).toContain("OFFSET $3");
    expect(listQuery?.sql).toContain("LEFT JOIN LATERAL");
    expect(listQuery?.sql).toContain("WHERE inventory_holds.item_id = item.item_id");
    expect(listQuery?.sql).toContain("AND status = 'active'");
    expect(listQuery?.sql).not.toContain("SELECT COUNT(*) AS count");
    expect(listQuery?.sql).not.toContain("GROUP BY item_id");
    expect(result.items[0]).not.toHaveProperty("total_count");
  });

  it("returns an empty account inventory page without catalog enrichment work", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        calls.push({ sql, values });

        if (sql.includes("WITH matching_items AS")) {
          return { rows: [], rowCount: 0 };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await listInventoryItems(db, { accountId: "acc_empty" });

    expect(result).toEqual({ items: [], total: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).not.toContain("SELECT COUNT(*) AS count");
    expect(calls.some((call) => call.sql.includes("inventory_catalog_items"))).toBe(false);
  });

  it("passes natural key and hold-derived availability filters into the paged inventory query", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        calls.push({ sql, values });

        if (sql.includes("WITH matching_items AS")) {
          return { rows: [], rowCount: 0 };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    await listInventoryItems(db, {
      accountId: "acc_1",
      catalogItemId: "cat_1",
      productId: "prod_1",
      storageLocationId: "loc_1",
      availability: "available",
      limit: 25,
      offset: 5,
    });

    expect(calls[0]?.values).toEqual(["acc_1", 25, 5, "cat_1", "prod_1", "loc_1", "available"]);
  });

  it("lists native CSV export rows scoped to the account", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        calls.push({ sql, values });
        return {
          rows: [
            {
              catalog_item_id: "cat_1",
              storage_location_id: "loc_1",
              total_quantity: 4,
              selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
              acquisition_cost_amount: "1.50",
            },
          ] as Row[],
          rowCount: 1,
        };
      },
    };

    const rows = await listNativeInventoryExportItems(db, { accountId: "acc_1" });

    expect(calls[0]?.sql).toContain("WHERE item.account_id = $1");
    expect(calls[0]?.sql).toContain("ORDER BY item.updated_at DESC, item.item_id ASC");
    expect(calls[0]?.values).toEqual(["acc_1"]);
    expect(rows).toEqual([
      {
        catalog_item_id: "cat_1",
        storage_location_id: "loc_1",
        total_quantity: 4,
        selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
        acquisition_cost_amount: "1.50",
      },
    ]);
  });
});
