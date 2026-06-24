import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createTransientProjectionError } from "@chase-sets/event-core/projector";
import type { OrderingOrderCreatedPayload } from "@chase-sets/event-core/public-event-payloads";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { InventoryHoldPlacementError, type InventoryHoldServices } from "../../holds/api/runtime";
import type { InventoryReservationServices } from "./runtime";
import { InventoryDomainError, type InventoryHoldId } from "../../../support/runtime-support/common";

type OrderReservationRequest = NonNullable<OrderingOrderCreatedPayload["reservationRequests"]>[number];

export type InventoryOrderReservationWorkflowServices = Readonly<{
  holds: InventoryHoldServices;
  reservations: InventoryReservationServices;
}>;

export type ReserveOrderInventoryRequestInput = Readonly<{
  orderId: string;
  request: OrderReservationRequest;
  context: EventStoreContext;
}>;

export function orderReservationHoldId(reservationRequestId: string): InventoryHoldId {
  const normalized = reservationRequestId.trim();
  if (!/^[a-zA-Z0-9_]+$/.test(normalized)) {
    throw new InventoryDomainError("Ordering reservation request id must use stream-safe characters.");
  }

  return `hld_order_reservation_${normalized}` as InventoryHoldId;
}

export async function reserveOrderInventoryRequest(
  services: InventoryOrderReservationWorkflowServices,
  input: ReserveOrderInventoryRequestInput,
): Promise<void> {
  const { orderId, request, context } = input;
  const existingState = await services.reservations.getReservationState(request.reservationRequestId);
  if (existingState.status !== null) {
    return;
  }

  let holdId: InventoryHoldId;
  try {
    const hold = await services.holds.createHold(
      {
        holdId: orderReservationHoldId(request.reservationRequestId),
        accountId: request.sellerAccountId as AccountId,
        itemId: request.inventoryItemId,
        quantity: request.quantity,
        reason: "Ordering commitment",
        notes: null,
      },
      context,
    );
    holdId = hold.holdId;
  } catch (error) {
    if (isTransientHoldPlacementFailure(error)) {
      throw createTransientProjectionError(error.message, { cause: error });
    }
    if (!isTerminalHoldPlacementFailure(error)) {
      throw error;
    }

    await services.reservations.commandHandler({
      streamId: `inventory.reservation-${request.reservationRequestId}`,
      command: {
        type: "RejectInventoryReservation",
        reservationRequestId: request.reservationRequestId,
        orderId,
        sellerAccountId: request.sellerAccountId,
        inventoryItemId: request.inventoryItemId,
        quantity: request.quantity,
        reason: error.message,
      },
      context,
    });
    return;
  }

  await services.reservations.commandHandler({
    streamId: `inventory.reservation-${request.reservationRequestId}`,
    command: {
      type: "ConfirmInventoryReservation",
      reservationRequestId: request.reservationRequestId,
      orderId,
      sellerAccountId: request.sellerAccountId,
      inventoryItemId: request.inventoryItemId,
      quantity: request.quantity,
      holdId,
    },
    context,
  });
}

function isTerminalHoldPlacementFailure(error: unknown): error is InventoryHoldPlacementError {
  return error instanceof InventoryHoldPlacementError && error.kind === "insufficient-available-quantity";
}

function isTransientHoldPlacementFailure(error: unknown): error is InventoryHoldPlacementError {
  return error instanceof InventoryHoldPlacementError && error.kind === "inventory-item-projection-missing";
}
