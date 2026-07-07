import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  inventoryHoldPurposes,
  inventoryHoldReleaseReasons,
  type InventoryHoldPlacedPayload,
  type InventoryHoldPurpose,
  type InventoryHoldReleaseReason,
  type InventoryHoldReleasedPayload,
  type InventoryHoldSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
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
  purpose: InventoryHoldPurpose | null;
  sourceRef: InventoryHoldSourceRef;
  expiresAt: string | null;
  status: InventoryHoldStatus;
  releasedAt: string | null;
  releaseReason: InventoryHoldReleaseReason | null;
  consumedAt: string | null;
}>;

export const initialInventoryHoldState: InventoryHoldState = {
  id: null,
  accountId: null,
  itemId: null,
  quantity: 0,
  reason: "",
  notes: null,
  purpose: null,
  sourceRef: null,
  expiresAt: null,
  status: "active",
  releasedAt: null,
  releaseReason: null,
  consumedAt: null,
};

export type PlaceInventoryHoldCommand = Readonly<{
  type: "PlaceInventoryHold";
  holdId: InventoryHoldId;
  accountId: AccountId;
  itemId: string;
  quantity: number;
  reason: string;
  notes?: string | null;
  purpose: InventoryHoldPurpose;
  sourceRef: InventoryHoldSourceRef;
  expiresAt?: string | null;
}>;

export type ReleaseInventoryHoldCommand = Readonly<{
  type: "ReleaseInventoryHold";
  releasedAt: string;
  releaseReason: InventoryHoldReleaseReason;
}>;

export type ConsumeInventoryHoldCommand = Readonly<{
  type: "ConsumeInventoryHold";
  consumedAt: string;
  consumptionReason: string;
}>;

export type InventoryHoldCommand =
  | PlaceInventoryHoldCommand
  | ReleaseInventoryHoldCommand
  | ConsumeInventoryHoldCommand;

export type InventoryHeldEvent = DomainEvent<
  "inventory.hold.placed",
  InventoryHoldPlacedPayload & Readonly<{ holdId: InventoryHoldId; accountId: AccountId }>
>;

export type InventoryReleasedEvent = DomainEvent<
  "inventory.hold.released",
  InventoryHoldReleasedPayload & Readonly<{ holdId: InventoryHoldId }>
>;

export type InventoryConsumedEvent = DomainEvent<
  "inventory.hold.consumed",
  Readonly<{
    holdId: InventoryHoldId;
    consumedAt: string;
    consumptionReason: string;
    sourceRef: InventoryHoldSourceRef;
  }>
>;

export type InventoryHoldEvent = InventoryHeldEvent | InventoryReleasedEvent | InventoryConsumedEvent;

export const decideInventoryHold: AggregateDecider<InventoryHoldState, InventoryHoldCommand, InventoryHoldEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "PlaceInventoryHold":
      assert(state.id === null, "Inventory hold has already been created.");
      ensurePositiveInteger(command.quantity, "Inventory holds require a positive quantity.");
      validateHoldPurpose(command.purpose);
      validateHoldSourceRef(command.purpose, command.sourceRef);
      validateHoldExpiry(command.purpose, command.expiresAt ?? null);
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
            purpose: command.purpose,
            sourceRef: normalizeHoldSourceRef(command.sourceRef),
            expiresAt: command.expiresAt ? normalizeLabel(command.expiresAt) : null,
          },
        },
      ];
    case "ReleaseInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can be released.");
      validateReleaseReason(command.releaseReason);
      return [
        {
          type: "inventory.hold.released",
          data: {
            holdId: state.id!,
            releasedAt: command.releasedAt,
            releaseReason: command.releaseReason,
          },
        },
      ];
    case "ConsumeInventoryHold":
      requireCreatedInventoryHold(state);
      assert(state.status === "active", "Only active holds can be consumed.");
      assert(state.sourceRef !== null, "Consumed inventory holds require order provenance.");
      return [
        {
          type: "inventory.hold.consumed",
          data: {
            holdId: state.id!,
            consumedAt: command.consumedAt,
            consumptionReason: normalizeLabel(command.consumptionReason),
            sourceRef: state.sourceRef,
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveInventoryHold: AggregateEvolver<InventoryHoldState, InventoryHoldEvent> = (state, event) => {
  switch (event.type) {
    case "inventory.hold.placed":
      return {
        id: event.data.holdId,
        accountId: event.data.accountId,
        itemId: event.data.itemId,
        quantity: event.data.quantity,
        reason: event.data.reason,
        notes: event.data.notes,
        purpose: event.data.purpose,
        sourceRef: event.data.sourceRef,
        expiresAt: event.data.expiresAt,
        status: "active",
        releasedAt: null,
        releaseReason: null,
        consumedAt: null,
      };
    case "inventory.hold.released":
      return {
        ...state,
        status: "released",
        releasedAt: event.data.releasedAt,
        releaseReason: event.data.releaseReason,
        consumedAt: null,
      };
    case "inventory.hold.consumed":
      return {
        ...state,
        status: "consumed",
        consumedAt: event.data.consumedAt,
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedInventoryHold(state: InventoryHoldState) {
  assert(state.id !== null, "Inventory hold must be created first.");
}

function validateHoldPurpose(purpose: InventoryHoldPurpose) {
  assert(
    (inventoryHoldPurposes as readonly string[]).includes(purpose),
    `Unsupported inventory hold purpose: ${String(purpose)}.`,
  );
  assert(
    purpose === "order" || purpose === "manual",
    `Inventory hold purpose ${purpose} is planned but not active yet.`,
  );
}

function validateReleaseReason(releaseReason: InventoryHoldReleaseReason) {
  assert(
    (inventoryHoldReleaseReasons as readonly string[]).includes(releaseReason),
    `Unsupported inventory hold release reason: ${String(releaseReason)}.`,
  );
}

function validateHoldSourceRef(purpose: InventoryHoldPurpose, sourceRef: InventoryHoldSourceRef) {
  if (purpose === "order") {
    assert(sourceRef !== null, "Order inventory holds require a source reference.");
    assert(normalizeLabel(sourceRef.orderId).length > 0, "Order inventory holds require an order id.");
    assert(
      normalizeLabel(sourceRef.reservationRequestId).length > 0,
      "Order inventory holds require a reservation request id.",
    );
    return;
  }

  assert(sourceRef === null, "Manual inventory holds cannot carry a source reference.");
}

function validateHoldExpiry(purpose: InventoryHoldPurpose, expiresAt: string | null) {
  if (purpose === "order" || purpose === "manual") {
    assert(expiresAt === null, `${purpose} inventory holds do not expire automatically.`);
  }
}

function normalizeHoldSourceRef(sourceRef: InventoryHoldSourceRef): InventoryHoldSourceRef {
  if (sourceRef === null) {
    return null;
  }

  return {
    orderId: normalizeLabel(sourceRef.orderId),
    reservationRequestId: normalizeLabel(sourceRef.reservationRequestId),
  };
}
