import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CompleteStreamReader } from "@chase-sets/event-core/complete-stream";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { InventoryDomainError } from "./common";
import { loadInventoryStockHolds, readInventoryStockHistory, validateInventoryItemStockHistory } from "./stock-history";
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

export type InventoryItemRepository = Readonly<{
  load: (streamId: string) => Promise<Readonly<{ state: InventoryItemState; version: number }>>;
}>;

export async function loadAuthoritativeInventoryStockSnapshot(input: {
  db: PgQueryable;
  eventStore: CompleteStreamReader;
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
  const itemEvents = await readInventoryStockHistory(input.eventStore, `inventory.item-${input.itemId}`);
  validateInventoryItemStockHistory({
    events: itemEvents,
    itemId: input.itemId,
    accountId: input.accountId,
    tenantId: input.context.tenantId,
    version: aggregate.version,
    totalQuantity: aggregate.state.totalQuantity,
  });
  const holds = await loadInventoryStockHolds(input);
  const heldQuantity = holds.filter((hold) => hold.active).reduce((total, hold) => total + hold.quantity, 0);
  if (!Number.isSafeInteger(heldQuantity) || heldQuantity > aggregate.state.totalQuantity) {
    throw new InventoryDomainError("Inventory stock history is unavailable; reconciliation is required.");
  }
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
  eventStore: CompleteStreamReader;
  itemRepository: InventoryItemRepository;
  itemId: string;
  accountId: AccountId;
  context: EventStoreContext;
  missingItemError?: () => Error;
}): Promise<InventoryStockSnapshot> {
  const item = await getInventoryHoldableItem(input.db, { itemId: input.itemId, accountId: input.accountId });
  if (item) return stockSnapshotFromReadModel(item);
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
