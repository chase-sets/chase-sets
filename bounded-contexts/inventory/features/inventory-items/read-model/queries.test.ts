import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { listNativeInventoryExportItems } from "./queries";

describe("inventory item read model queries", () => {
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
