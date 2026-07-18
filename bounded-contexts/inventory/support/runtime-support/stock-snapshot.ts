import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { InventoryDomainError } from "./common";
import type { InventoryItemState } from "../../features/inventory-items/domain/domain";
import {
  getInventoryHoldableItem,
  type InventoryHoldableItemRow,
} from "../../features/inventory-items/read-model/queries";

export type InventoryStockSnapshot = Readonly<{
  itemId: string;
  accountId: AccountId;
  totalQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
}>;

type AggregateHoldSnapshot = Readonly<{
  accountId: AccountId;
  itemId: string;
  quantity: number;
  active: boolean;
}>;

type AggregateHoldSnapshotRow = Readonly<{
  hold_id: string;
  account_id: string;
  item_id: string;
  quantity: string | number;
  active: boolean;
}>;

export type InventoryItemRepository = Readonly<{
  load: (streamId: string) => Promise<Readonly<{ state: InventoryItemState; version: number }>>;
}>;

export async function loadAuthoritativeInventoryStockSnapshot(input: {
  db: PgQueryable;
  itemRepository: InventoryItemRepository;
  itemId: string;
  accountId: AccountId;
  context: EventStoreContext;
  itemAggregate?: Readonly<{ state: InventoryItemState; version: number }>;
  missingItemError?: () => Error;
}): Promise<InventoryStockSnapshot> {
  const aggregate = input.itemAggregate ?? (await input.itemRepository.load(`inventory.item-${input.itemId}`));
  if (aggregate.state.id !== input.itemId || aggregate.state.accountId !== input.accountId) {
    throw input.missingItemError?.() ?? new InventoryDomainError("Inventory item not found.");
  }

  const holds = await loadAggregateHoldSnapshots({
    db: input.db,
    accountId: input.accountId,
    itemId: input.itemId,
    tenantId: input.context.tenantId,
  });
  const heldQuantity = [...holds.values()]
    .filter((hold) => hold.active && hold.accountId === input.accountId && hold.itemId === input.itemId)
    .reduce((total, hold) => total + hold.quantity, 0);

  return {
    itemId: input.itemId,
    accountId: input.accountId,
    totalQuantity: aggregate.state.totalQuantity,
    heldQuantity,
    availableQuantity: aggregate.state.totalQuantity - heldQuantity,
  };
}

export async function loadInventoryStockSnapshot(input: {
  db: PgQueryable;
  itemRepository: InventoryItemRepository;
  itemId: string;
  accountId: AccountId;
  context: EventStoreContext;
  missingItemError?: () => Error;
}): Promise<InventoryStockSnapshot> {
  const item = await getInventoryHoldableItem(input.db, {
    itemId: input.itemId,
    accountId: input.accountId,
  });
  if (item) {
    return stockSnapshotFromReadModel(item);
  }

  return loadAuthoritativeInventoryStockSnapshot(input);
}

function stockSnapshotFromReadModel(item: InventoryHoldableItemRow): InventoryStockSnapshot {
  return {
    itemId: item.item_id,
    accountId: item.account_id as AccountId,
    totalQuantity: item.total_quantity,
    heldQuantity: item.held_quantity,
    availableQuantity: item.available_quantity,
  };
}

async function loadAggregateHoldSnapshots(input: {
  db: PgQueryable;
  accountId: AccountId;
  itemId: string;
  tenantId: string;
}): Promise<Map<string, AggregateHoldSnapshot>> {
  const result = await input.db.query<AggregateHoldSnapshotRow>(
    `WITH placed_holds AS (
       SELECT
         stream_id,
         payload ->> 'holdId' AS hold_id,
         payload ->> 'accountId' AS account_id,
         payload ->> 'itemId' AS item_id,
         payload ->> 'quantity' AS quantity
       FROM event_store_events
       WHERE tenant_id = $1
         AND stream_context_name = 'inventory'
         AND stream_category = 'inventory.hold'
         AND event_type = 'inventory.hold.placed'
         AND payload ->> 'accountId' = $2
         AND payload ->> 'itemId' = $3
         AND jsonb_typeof(payload -> 'quantity') = 'number'
     )
     SELECT
       placed_holds.stream_id,
       hold_id,
       account_id,
       item_id,
       quantity,
       terminal_holds.stream_id IS NULL AS active
     FROM placed_holds
     LEFT JOIN event_store_events AS terminal_holds
       ON terminal_holds.stream_id = placed_holds.stream_id
      AND terminal_holds.tenant_id = $1
      AND terminal_holds.event_type IN ('inventory.hold.released', 'inventory.hold.expired', 'inventory.hold.consumed')`,
    [input.tenantId, input.accountId, input.itemId],
  );

  return new Map(
    result.rows.flatMap((row) => {
      const quantity = Number(row.quantity);
      if (!row.hold_id || !row.account_id || !row.item_id || !Number.isInteger(quantity) || quantity <= 0) {
        return [];
      }

      return [
        [
          row.hold_id,
          {
            accountId: row.account_id as AccountId,
            itemId: row.item_id,
            quantity,
            active: row.active,
          },
        ] as const,
      ];
    }),
  );
}
