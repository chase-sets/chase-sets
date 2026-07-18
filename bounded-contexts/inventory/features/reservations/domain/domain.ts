import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { InventoryHoldReleaseReason } from "@chase-sets/event-core/public-event-payloads";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeLabel,
  normalizeOptionalText,
} from "../../../support/runtime-support/common";

export type InventoryReservationState = Readonly<{
  reservationRequestId: string | null;
  orderId: string | null;
  sellerAccountId: string | null;
  inventoryItemId: string | null;
  quantity: number;
  holdId: string | null;
  status: "pending" | "confirmed" | "rejected" | "released" | null;
  rejectionReason: string | null;
  releasedAt: string | null;
  releaseReason: InventoryHoldReleaseReason | null;
}>;

export const initialInventoryReservationState: InventoryReservationState = {
  reservationRequestId: null,
  orderId: null,
  sellerAccountId: null,
  inventoryItemId: null,
  quantity: 0,
  holdId: null,
  status: null,
  rejectionReason: null,
  releasedAt: null,
  releaseReason: null,
};

export type ConfirmInventoryReservationCommand = Readonly<{
  type: "ConfirmInventoryReservation";
  reservationRequestId: string;
  orderId: string;
  sellerAccountId: string;
  inventoryItemId: string;
  quantity: number;
  holdId: string;
}>;

export type RejectInventoryReservationCommand = Readonly<{
  type: "RejectInventoryReservation";
  reservationRequestId: string;
  orderId: string;
  sellerAccountId: string;
  inventoryItemId: string;
  quantity: number;
  reason: string;
}>;

export type ReleaseInventoryReservationCommand = Readonly<{
  type: "ReleaseInventoryReservation";
  releasedAt: string;
  releaseReason: InventoryHoldReleaseReason;
}>;

export type InventoryReservationCommand =
  | ConfirmInventoryReservationCommand
  | RejectInventoryReservationCommand
  | ReleaseInventoryReservationCommand;

export type InventoryReservationConfirmedEvent = DomainEvent<
  "inventory.reservation.confirmed",
  Readonly<{
    reservationRequestId: string;
    orderId: string;
    sellerAccountId: string;
    inventoryItemId: string;
    quantity: number;
    holdId: string;
  }>
>;

export type InventoryReservationRejectedEvent = DomainEvent<
  "inventory.reservation.rejected",
  Readonly<{
    reservationRequestId: string;
    orderId: string;
    sellerAccountId: string;
    inventoryItemId: string;
    quantity: number;
    reason: string;
  }>
>;

export type InventoryReservationReleasedEvent = DomainEvent<
  "inventory.reservation.released",
  Readonly<{
    reservationRequestId: string;
    orderId: string;
    holdId: string;
    sellerAccountId: string;
    releasedAt: string;
    releaseReason: InventoryHoldReleaseReason;
  }>
>;

export type InventoryReservationEvent =
  | InventoryReservationConfirmedEvent
  | InventoryReservationRejectedEvent
  | InventoryReservationReleasedEvent;

function normalizeReservationInput(
  input: Readonly<{
    reservationRequestId: string;
    orderId: string;
    sellerAccountId: string;
    inventoryItemId: string;
    quantity: number;
  }>,
) {
  return {
    reservationRequestId: normalizeLabel(input.reservationRequestId),
    orderId: normalizeLabel(input.orderId),
    sellerAccountId: normalizeLabel(input.sellerAccountId),
    inventoryItemId: normalizeLabel(input.inventoryItemId),
    quantity: ensurePositiveInteger(input.quantity, "Inventory reservation quantity must be a positive whole number."),
  };
}

export const decideInventoryReservation: AggregateDecider<
  InventoryReservationState,
  InventoryReservationCommand,
  InventoryReservationEvent
> = (state, command) => {
  switch (command.type) {
    case "ConfirmInventoryReservation": {
      const normalized = normalizeReservationInput(command);
      const holdId = normalizeLabel(command.holdId);

      if (state.status === "confirmed" && state.holdId === holdId) {
        return [];
      }

      assert(state.status === null, "Inventory reservation has already been resolved.");

      return [
        {
          type: "inventory.reservation.confirmed",
          data: {
            ...normalized,
            holdId,
          },
        },
      ];
    }
    case "RejectInventoryReservation": {
      const normalized = normalizeReservationInput(command);
      const reason = normalizeLabel(command.reason);

      if (state.status === "rejected" && state.rejectionReason === reason) {
        return [];
      }

      assert(state.status === null, "Inventory reservation has already been resolved.");

      return [
        {
          type: "inventory.reservation.rejected",
          data: {
            ...normalized,
            reason,
          },
        },
      ];
    }
    case "ReleaseInventoryReservation":
      assert(state.status === "confirmed", "Only confirmed inventory reservations can be released.");
      return [
        {
          type: "inventory.reservation.released",
          data: {
            reservationRequestId: state.reservationRequestId!,
            orderId: state.orderId!,
            holdId: state.holdId!,
            sellerAccountId: state.sellerAccountId!,
            releasedAt: normalizeLabel(command.releasedAt),
            releaseReason: command.releaseReason,
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveInventoryReservation: AggregateEvolver<InventoryReservationState, InventoryReservationEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "inventory.reservation.confirmed":
      return {
        reservationRequestId: event.data.reservationRequestId,
        orderId: event.data.orderId,
        sellerAccountId: event.data.sellerAccountId,
        inventoryItemId: event.data.inventoryItemId,
        quantity: event.data.quantity,
        holdId: event.data.holdId,
        status: "confirmed",
        rejectionReason: null,
        releasedAt: null,
        releaseReason: null,
      };
    case "inventory.reservation.rejected":
      return {
        reservationRequestId: event.data.reservationRequestId,
        orderId: event.data.orderId,
        sellerAccountId: event.data.sellerAccountId,
        inventoryItemId: event.data.inventoryItemId,
        quantity: event.data.quantity,
        holdId: null,
        status: "rejected",
        rejectionReason: normalizeOptionalText(event.data.reason),
        releasedAt: null,
        releaseReason: null,
      };
    case "inventory.reservation.released":
      return {
        ...state,
        status: "released",
        releasedAt: event.data.releasedAt,
        releaseReason: event.data.releaseReason,
      };
    default:
      return assertNever(event);
  }
};
