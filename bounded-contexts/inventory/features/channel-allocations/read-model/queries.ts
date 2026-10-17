import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  absentChannelStockAllocation,
  type ChannelStockAllocation,
  type ChannelStockAllocationPartition,
} from "../domain/allocation";

export async function readChannelStockAllocation(
  db: PgQueryable,
  input: Readonly<{ accountId: string; inventoryItemId: string }>,
): Promise<ChannelStockAllocation> {
  const result = await db.query<{
    account_id: string;
    inventory_item_id: string;
    mode: "shared-pool" | "partitioned";
    partitions: unknown;
    set_at: string | Date;
    allocation_revision: string | number;
  }>(
    `SELECT account_id,inventory_item_id,mode,partitions,set_at,allocation_revision
     FROM inventory_channel_stock_allocations
     WHERE account_id=$1 AND inventory_item_id=$2`,
    [input.accountId, input.inventoryItemId],
  );
  const row = result.rows[0];
  if (!row) return absentChannelStockAllocation(input.accountId, input.inventoryItemId);
  return {
    accountId: row.account_id,
    inventoryItemId: row.inventory_item_id,
    mode: row.mode,
    partitions: decodePartitions(row.partitions),
    revision: Number(row.allocation_revision),
    setAt: new Date(row.set_at).toISOString(),
  };
}

function decodePartitions(value: unknown): readonly ChannelStockAllocationPartition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof (candidate as Record<string, unknown>).channelConnectionId !== "string" ||
      !Number.isSafeInteger((candidate as Record<string, unknown>).units)
    ) {
      return [];
    }
    return [
      {
        channelConnectionId: (candidate as Record<string, unknown>).channelConnectionId as string,
        units: Number((candidate as Record<string, unknown>).units),
      },
    ];
  });
}
