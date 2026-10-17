import type { InventoryChannelStockAllocationSetPayload } from "@chase-sets/event-core/public-event-payloads/inventory";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildInventoryChannelStockAllocationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.channel-stock-allocation.set": async (event) => {
      const data = event.data as InventoryChannelStockAllocationSetPayload;
      await db.query(
        `INSERT INTO inventory_channel_stock_allocations
           (account_id,inventory_item_id,mode,partitions,set_at,allocation_revision)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)
         ON CONFLICT (inventory_item_id) DO UPDATE SET
           account_id=EXCLUDED.account_id, mode=EXCLUDED.mode, partitions=EXCLUDED.partitions,
           set_at=EXCLUDED.set_at, allocation_revision=EXCLUDED.allocation_revision
         WHERE inventory_channel_stock_allocations.allocation_revision < EXCLUDED.allocation_revision`,
        [
          data.accountId,
          data.inventoryItemId,
          data.mode,
          JSON.stringify(data.partitions),
          data.setAt,
          event.streamVersion,
        ],
      );
    },
  };
}
