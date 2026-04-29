import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeLabel,
  normalizeOptionalText,
  type InventoryHoldId,
  type InventoryHoldStatus,
} from "../../../support/runtime-support/common";

export type InventoryHoldState = Readonly<{
  id: InventoryHoldId | null;
  accountId: AccountId | null;
  itemId: string | null;
  quantity: number;
  reason: string;
  notes: string | null;
  status: InventoryHoldStatus;
  releasedAt: string | null;
}>;

export const initialInventoryHoldState: InventoryHoldState = {
  id: null,
  accountId: null,
  itemId: null,
  quantity: 0,
  reason: "",
  notes: null,
  status: "active",
  releasedAt: null,
};

export type PlaceInventoryHoldCommand = Readonly<{
  type: "PlaceInventoryHold";
  holdId: InventoryHoldId;
  accountId: AccountId;
  itemId: string;
  quantity: number;
  reason: string;
  notes?: string | null;
}>;

export type ReleaseInventoryHoldCommand = Readonly<{
  type: "ReleaseInventoryHold";
  releasedAt: string;
}>;

export type InventoryHoldCommand =
  | PlaceInventoryHoldCommand
  | ReleaseInventoryHoldCommand;

export type InventoryHeldEvent = DomainEvent<
  "inventory.hold.placed",
  Readonly<{
    holdId: InventoryHoldId;
    accountId: AccountId;
    itemId: string;
    quantity: number;
    reason: string;
    notes: string | null;
  }>
>;

export type InventoryReleasedEvent = DomainEvent<
  "inventory.hold.released",
  Readonly<{
    holdId: InventoryHoldId;
    releasedAt: string;
  }>
>;

export type InventoryHoldEvent = InventoryHeldEvent | InventoryReleasedEvent;

export const decideInventoryHold: AggregateDecider<
  InventoryHoldState,
  InventoryHoldCommand,
  InventoryHoldEvent
> = (state, command) => {
  switch (command.type) {
    case "PlaceInventoryHold":
      assert(state.id === null, "Inventory hold has already been created.");
      ensurePositiveInteger(command.quantity, "Inventory holds require a positive quantity.");
      return [
        {
          type: "inventory.hold.placed",
          data: {
            holdId: command.holdId,
            accountId: command.accountId,
            itemId: normalizeLabel(command.itemId),
            quantity: command.quantity,
            reason: normalizeLabel(command.reason),
            notes: normalizeOptionalText(command.notes),
          },
        },
      ];
    case "ReleaseInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can be released.");
      return [
        {
          type: "inventory.hold.released",
          data: {
            holdId: state.id!,
            releasedAt: command.releasedAt,
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveInventoryHold: AggregateEvolver<
  InventoryHoldState,
  InventoryHoldEvent
> = (state, event) => {
  switch (event.type) {
    case "inventory.hold.placed":
      return {
        id: event.data.holdId,
        accountId: event.data.accountId,
        itemId: event.data.itemId,
        quantity: event.data.quantity,
        reason: event.data.reason,
        notes: event.data.notes,
        status: "active",
        releasedAt: null,
      };
    case "inventory.hold.released":
      return {
        ...state,
        status: "released",
        releasedAt: event.data.releasedAt,
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedInventoryHold(state: InventoryHoldState) {
  assert(state.id !== null, "Inventory hold must be created first.");
}
