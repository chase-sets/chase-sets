import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, InventoryRecordId } from "@chase-sets/primitives/typed-ids";
import type { InventorySelectedOptionEntry } from "../integrations/catalog/versioning";
import {
  assert,
  assertNever,
  ensureInteger,
  ensurePositiveInteger,
  normalizeLabel,
} from "../../../support/runtime-support/common";

export type InventoryRecordState = Readonly<{
  id: InventoryRecordId | null;
  accountId: AccountId | null;
  catalogItemId: string | null;
  productId: string | null;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  storageLocationId: string | null;
  totalQuantity: number;
  acquisitionCostAmount: string | null;
}>;

export const initialInventoryRecordState: InventoryRecordState = {
  id: null,
  accountId: null,
  catalogItemId: null,
  productId: null,
  selectedOptions: [],
  storageLocationId: null,
  totalQuantity: 0,
  acquisitionCostAmount: null,
};

export type CreateInventoryRecordCommand = Readonly<{
  type: "CreateInventoryRecord";
  recordId: InventoryRecordId;
  accountId: AccountId;
  catalogItemId: string;
  productId: string;
  selectedOptions?: readonly InventorySelectedOptionEntry[];
  storageLocationId: string;
  totalQuantity: number;
  acquisitionCostAmount?: string | null;
}>;

export type AdjustInventoryRecordQuantityCommand = Readonly<{
  type: "AdjustInventoryRecordQuantity";
  quantityDelta: number;
  reason: string;
}>;

export type InventoryRecordCommand =
  | CreateInventoryRecordCommand
  | AdjustInventoryRecordQuantityCommand;

export type InventoryRecordCreatedEvent = DomainEvent<
  "inventory.record.created",
  Readonly<{
    recordId: InventoryRecordId;
    accountId: AccountId;
    catalogItemId: string;
    productId: string;
    selectedOptions: InventorySelectedOptionEntry[];
    storageLocationId: string;
    totalQuantity: number;
    acquisitionCostAmount: string | null;
  }>
>;

export type InventoryRecordAdjustedEvent = DomainEvent<
  "inventory.record.adjusted",
  Readonly<{
    recordId: InventoryRecordId;
    quantityDelta: number;
    reason: string;
  }>
>;

export type InventoryRecordEvent =
  | InventoryRecordCreatedEvent
  | InventoryRecordAdjustedEvent;

export const decideInventoryRecord: AggregateDecider<
  InventoryRecordState,
  InventoryRecordCommand,
  InventoryRecordEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateInventoryRecord":
      assert(state.id === null, "Inventory record has already been created.");
      ensurePositiveInteger(
        command.totalQuantity,
        "Inventory records require a positive total quantity.",
      );
      return [
        {
          type: "inventory.record.created",
          data: {
            recordId: command.recordId,
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
    case "AdjustInventoryRecordQuantity":
      requireCreatedInventoryRecord(state);
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
          type: "inventory.record.adjusted",
          data: {
            recordId: state.id!,
            quantityDelta: command.quantityDelta,
            reason: normalizeLabel(command.reason),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveInventoryRecord: AggregateEvolver<
  InventoryRecordState,
  InventoryRecordEvent
> = (state, event) => {
  switch (event.type) {
    case "inventory.record.created":
      return {
        id: event.data.recordId,
        accountId: event.data.accountId,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        selectedOptions: event.data.selectedOptions,
        storageLocationId: event.data.storageLocationId,
        totalQuantity: event.data.totalQuantity,
        acquisitionCostAmount: event.data.acquisitionCostAmount,
      };
    case "inventory.record.adjusted":
      return {
        ...state,
        totalQuantity: state.totalQuantity + event.data.quantityDelta,
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedInventoryRecord(state: InventoryRecordState) {
  assert(state.id !== null, "Inventory record must be created first.");
}
