import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import type { InventorySelectedOptionEntry } from "../integrations/catalog/versioning";
import {
  assert,
  assertNever,
  ensureInteger,
  ensurePositiveInteger,
  normalizeLabel,
} from "../../../support/runtime-support/common";

export type InventoryItemState = Readonly<{
  id: InventoryItemId | null;
  accountId: AccountId | null;
  catalogItemId: string | null;
  productId: string | null;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  storageLocationId: string | null;
  totalQuantity: number;
  acquisitionCostAmount: string | null;
}>;

export const initialInventoryItemState: InventoryItemState = {
  id: null,
  accountId: null,
  catalogItemId: null,
  productId: null,
  selectedOptions: [],
  storageLocationId: null,
  totalQuantity: 0,
  acquisitionCostAmount: null,
};

export type CreateInventoryItemCommand = Readonly<{
  type: "CreateInventoryItem";
  itemId: InventoryItemId;
  accountId: AccountId;
  catalogItemId: string;
  productId: string;
  selectedOptions?: readonly InventorySelectedOptionEntry[];
  storageLocationId: string;
  totalQuantity: number;
  acquisitionCostAmount?: string | null;
}>;

export type AdjustInventoryItemQuantityCommand = Readonly<{
  type: "AdjustInventoryItemQuantity";
  quantityDelta: number;
  reason: string;
}>;

export type InventoryItemCommand =
  | CreateInventoryItemCommand
  | AdjustInventoryItemQuantityCommand;

export type InventoryItemCreatedEvent = DomainEvent<
  "inventory.item.created",
  Readonly<{
    itemId: InventoryItemId;
    accountId: AccountId;
    catalogItemId: string;
    productId: string;
    selectedOptions: InventorySelectedOptionEntry[];
    storageLocationId: string;
    totalQuantity: number;
    acquisitionCostAmount: string | null;
  }>
>;

export type InventoryItemAdjustedEvent = DomainEvent<
  "inventory.item.adjusted",
  Readonly<{
    itemId: InventoryItemId;
    quantityDelta: number;
    reason: string;
  }>
>;

export type InventoryItemEvent =
  | InventoryItemCreatedEvent
  | InventoryItemAdjustedEvent;

export const decideInventoryItem: AggregateDecider<
  InventoryItemState,
  InventoryItemCommand,
  InventoryItemEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateInventoryItem":
      assert(state.id === null, "Inventory item has already been created.");
      ensurePositiveInteger(
        command.totalQuantity,
        "Inventory items require a positive total quantity.",
      );
      return [
        {
          type: "inventory.item.created",
          data: {
            itemId: command.itemId,
            accountId: command.accountId,
            catalogItemId: normalizeLabel(command.catalogItemId),
            productId: command.productId,
            selectedOptions: (command.selectedOptions ?? []).map((entry) => ({
              dimensionId: normalizeLabel(entry.dimensionId),
              optionId: normalizeLabel(entry.optionId),
            })),
            storageLocationId: normalizeLabel(command.storageLocationId),
            totalQuantity: command.totalQuantity,
            acquisitionCostAmount: command.acquisitionCostAmount ?? null,
          },
        },
      ];
    case "AdjustInventoryItemQuantity":
      requireCreatedInventoryItem(state);
      ensureInteger(
        command.quantityDelta,
        "Inventory adjustments must use a whole-number quantity delta.",
      );
      assert(command.quantityDelta !== 0, "Quantity adjustments must change inventory.");
      assert(
        state.totalQuantity + command.quantityDelta >= 0,
        "Inventory quantity cannot fall below zero.",
      );
      return [
        {
          type: "inventory.item.adjusted",
          data: {
            itemId: state.id!,
            quantityDelta: command.quantityDelta,
            reason: normalizeLabel(command.reason),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveInventoryItem: AggregateEvolver<
  InventoryItemState,
  InventoryItemEvent
> = (state, event) => {
  switch (event.type) {
    case "inventory.item.created":
      return {
        id: event.data.itemId,
        accountId: event.data.accountId,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        selectedOptions: event.data.selectedOptions,
        storageLocationId: event.data.storageLocationId,
        totalQuantity: event.data.totalQuantity,
        acquisitionCostAmount: event.data.acquisitionCostAmount,
      };
    case "inventory.item.adjusted":
      return {
        ...state,
        totalQuantity: state.totalQuantity + event.data.quantityDelta,
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedInventoryItem(state: InventoryItemState) {
  assert(state.id !== null, "Inventory item must be created first.");
}
