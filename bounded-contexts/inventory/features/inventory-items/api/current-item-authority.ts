import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { loadAuthoritativeInventoryStockSnapshot } from "../../../support/runtime-support/stock-snapshot";
import {
  decideStorageLocation,
  evolveStorageLocation,
  initialStorageLocationState,
  type StorageLocationEvent,
} from "../../storage-locations/domain/domain";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
} from "../domain/domain";

export type InventoryCurrentItem = Readonly<{
  catalogItemId: string;
  productId: string;
  storageLocation: Readonly<{
    storageLocationId: string;
    name: string;
    shipFromCode: string;
    shipFromAddress: AddressSnapshot;
    status: "active" | "retired";
  }>;
  totalQuantity: number;
  availableQuantity: number;
  acquisitionCostAmount: string | null;
  acquisitionCostCurrencyCode: string | null;
}>;

/**
 * Read-only authority for what Inventory records about an item now: the Catalog Item and Product it was created
 * for, its storage location with that location's current name and ship-from details, its total quantity, the
 * quantity no active hold covers, and its acquisition cost.
 *
 * Everything is folded from the item's, its location's and its holds' event streams, never from a projection, so
 * the answer does not wait on projection lag. No command is issued and no event is appended.
 */
export function createInventoryCurrentItemAuthority(pool: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool });
  const items = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<InventoryItemEvent>(),
    initialState: () => initialInventoryItemState,
    evolve: evolveInventoryItem,
    decide: decideInventoryItem,
  }).repository;
  const locations = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<StorageLocationEvent>(),
    initialState: () => initialStorageLocationState,
    evolve: evolveStorageLocation,
    decide: decideStorageLocation,
  }).repository;

  return {
    async resolveInventoryCurrentItem(
      input: Readonly<{ accountId: string; inventoryItemId: string }>,
      context: EventStoreContext,
    ): Promise<InventoryCurrentItem | null> {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "accountId" && key !== "inventoryItemId") ||
        typeof input.accountId !== "string" ||
        input.accountId.length === 0 ||
        typeof input.inventoryItemId !== "string" ||
        input.inventoryItemId.length === 0
      ) {
        throw new Error("Invalid inventory current item authority input.");
      }
      const item = await items.load(`inventory.item-${input.inventoryItemId}`);
      const { state } = item;
      if (
        state.id !== input.inventoryItemId ||
        state.accountId !== input.accountId ||
        state.catalogItemId === null ||
        state.productId === null ||
        state.storageLocationId === null
      ) {
        return null;
      }
      const location = (await locations.load(`inventory.storage-location-${state.storageLocationId}`)).state;
      if (
        location.id !== state.storageLocationId ||
        location.accountId !== input.accountId ||
        location.shipFromCode === null ||
        location.shipFromAddress === null
      ) {
        return null;
      }
      const stock = await loadAuthoritativeInventoryStockSnapshot({
        db: pool,
        eventStore,
        itemRepository: items,
        itemAggregate: item,
        itemId: input.inventoryItemId,
        accountId: input.accountId as AccountId,
        context,
      });
      return {
        catalogItemId: state.catalogItemId,
        productId: state.productId,
        storageLocation: {
          storageLocationId: location.id,
          name: location.name,
          shipFromCode: location.shipFromCode,
          shipFromAddress: location.shipFromAddress,
          status: location.isArchived ? "retired" : "active",
        },
        totalQuantity: stock.totalQuantity,
        availableQuantity: stock.availableQuantity,
        acquisitionCostAmount: state.acquisitionCostAmount,
        acquisitionCostCurrencyCode: state.acquisitionCostCurrencyCode,
      };
    },
  };
}
