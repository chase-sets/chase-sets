import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";

export type InventoryListingCapacityState = Readonly<{
  inventoryItemId: string | null;
  listingIds: readonly string[];
}>;

export const initialInventoryListingCapacityState: InventoryListingCapacityState = {
  inventoryItemId: null,
  listingIds: [],
};

export type RegisterInventoryListingsCommand = Readonly<{
  type: "RegisterInventoryListings";
  inventoryItemId: string;
  listingIds: readonly string[];
}>;

export type CommitInventoryListingCapacityCommand = Readonly<{
  type: "CommitInventoryListingCapacity";
  inventoryItemId: string;
  listingId: string;
  quantityCap: number;
}>;

export type InventoryListingCapacityCommand = RegisterInventoryListingsCommand | CommitInventoryListingCapacityCommand;

export type InventoryListingsRegisteredEvent = DomainEvent<
  "marketplace.inventory-listings.registered",
  Readonly<{ inventoryItemId: string; listingIds: string[] }>
>;

export type InventoryListingCapacityCommittedEvent = DomainEvent<
  "marketplace.inventory-listing-capacity.committed",
  Readonly<{ inventoryItemId: string; listingId: string; quantityCap: number }>
>;

export type InventoryListingCapacityEvent = InventoryListingsRegisteredEvent | InventoryListingCapacityCommittedEvent;

function normalizeInventoryItemId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Inventory item id is required for listing capacity.");
  }
  return normalized;
}

function normalizeListingIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function assertInventoryItem(state: InventoryListingCapacityState, inventoryItemId: string): void {
  if (state.inventoryItemId !== null && state.inventoryItemId !== inventoryItemId) {
    throw new Error("Inventory listing capacity cannot span inventory items.");
  }
}

export const decideInventoryListingCapacity: AggregateDecider<
  InventoryListingCapacityState,
  InventoryListingCapacityCommand,
  InventoryListingCapacityEvent
> = (state, command) => {
  const inventoryItemId = normalizeInventoryItemId(command.inventoryItemId);
  assertInventoryItem(state, inventoryItemId);

  switch (command.type) {
    case "RegisterInventoryListings": {
      const known = new Set(state.listingIds);
      const additions = normalizeListingIds(command.listingIds).filter((listingId) => !known.has(listingId));
      return additions.length === 0
        ? []
        : [{ type: "marketplace.inventory-listings.registered", data: { inventoryItemId, listingIds: additions } }];
    }
    case "CommitInventoryListingCapacity": {
      if (!Number.isInteger(command.quantityCap) || command.quantityCap <= 0) {
        throw new Error("Listing quantity cap must be a positive whole number.");
      }
      const listingId = command.listingId.trim();
      if (!listingId) {
        throw new Error("Listing id is required for inventory capacity.");
      }
      return [
        {
          type: "marketplace.inventory-listing-capacity.committed",
          data: { inventoryItemId, listingId, quantityCap: command.quantityCap },
        },
      ];
    }
  }
};

export const evolveInventoryListingCapacity: AggregateEvolver<
  InventoryListingCapacityState,
  InventoryListingCapacityEvent
> = (state, event) => ({
  inventoryItemId: event.data.inventoryItemId,
  listingIds: [
    ...new Set([
      ...state.listingIds,
      ...(event.type === "marketplace.inventory-listings.registered" ? event.data.listingIds : [event.data.listingId]),
    ]),
  ].sort(),
});

export function inventoryListingCapacityStreamId(inventoryItemId: string): string {
  return `marketplace.inventory-listing-capacity-${inventoryItemId.trim()}`;
}

export function assertActiveListingCapacity(
  listings: readonly Readonly<{ status: string; quantityCap: number }>[],
  sellableQuantity: number,
): void {
  const activeQuantityCap = listings.reduce(
    (total, listing) => total + (listing.status === "active" ? listing.quantityCap : 0),
    0,
  );
  if (activeQuantityCap > sellableQuantity) {
    throw new Error("Active listing quantity caps cannot exceed current sellable inventory.");
  }
}
