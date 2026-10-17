import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const channelStockAllocationTable = `CREATE TABLE IF NOT EXISTS inventory_channel_stock_allocations (
  account_id text NOT NULL,
  inventory_item_id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('shared-pool','partitioned')),
  partitions jsonb NOT NULL,
  set_at timestamptz NOT NULL,
  allocation_revision bigint NOT NULL CHECK (allocation_revision >= 1),
  UNIQUE (account_id, inventory_item_id)
)`;

const accountIndex =
  "CREATE INDEX IF NOT EXISTS inventory_channel_stock_allocations_account_idx ON inventory_channel_stock_allocations (account_id, inventory_item_id)";
const accountIndexMigration =
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_channel_stock_allocations_account_idx ON inventory_channel_stock_allocations (account_id, inventory_item_id)";

export const inventoryChannelStockAllocationSchemaSql = `${channelStockAllocationTable};\n${accountIndex};`;

export const inventoryChannelStockAllocationSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260911_inventory_channel_stock_allocation",
    description: "Create the Inventory-owned Channel Stock Allocation read model.",
    statements: [channelStockAllocationTable, accountIndexMigration],
  },
];

export const INVENTORY_CHANNEL_STOCK_ALLOCATIONS_TABLE_NAME = "inventory_channel_stock_allocations";
