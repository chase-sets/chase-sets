import { describe, expect, it } from "vitest";

import { inventoryItemSchemaMigrations, inventoryItemSchemaSql } from "../features/inventory-items/read-model/schema";

describe("fresh inventory schemas", () => {
  it("keeps stock-ledger indexes out of boot-time schema SQL", () => {
    const migrationSql = inventoryItemSchemaMigrations.flatMap((migration) => migration.statements).join("\n");

    expect(inventoryItemSchemaSql).toContain("CREATE TABLE IF NOT EXISTS inventory_item_ledger");
    expect(inventoryItemSchemaSql).toContain("reason_code text NULL");
    expect(inventoryItemSchemaSql).toContain("note text NULL");
    expect(inventoryItemSchemaSql).toContain("sale_price_amount numeric(12,2) NULL");
    expect(inventoryItemSchemaSql).toContain("channel text NULL");
    expect(inventoryItemSchemaSql).toContain("result_collision jsonb NULL");
    expect(inventoryItemSchemaSql).not.toContain("inventory_item_ledger_item_occurred_idx");
    expect(inventoryItemSchemaSql).not.toContain("inventory_item_ledger_account_item_idx");
    expect(migrationSql).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_item_ledger_item_occurred_idx");
    expect(migrationSql).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_item_ledger_account_item_idx");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS reason_code text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS note text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS sale_price_amount numeric(12,2)");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS channel text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS result_collision jsonb");
  });
});
