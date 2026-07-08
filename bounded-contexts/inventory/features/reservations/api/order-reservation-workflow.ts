import type { AppendToStreamsResult } from "@chase-sets/event-core/event-store";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
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
  appendToStreams: (inputs: readonly AppendToStreamInput[]) => Promise<readonly AppendToStreamsResult[]>;
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
  let holdPlan:
    | Awaited<ReturnType<InventoryHoldServices["planCreateHold"]>>
    | Awaited<ReturnType<InventoryHoldServices["planConvertCheckoutHold"]>>;
  try {
    if (request.holdId) {
      holdPlan = await services.holds.planConvertCheckoutHold(
        {
          holdId: request.holdId as InventoryHoldId,
          accountId: request.sellerAccountId as AccountId,
          itemId: request.inventoryItemId,
          quantity: request.quantity,
          orderId,
          reservationRequestId: request.reservationRequestId,
        },
        context,
      );
    } else {
      holdPlan = await services.holds.planCreateHold(
        {
          holdId: orderReservationHoldId(request.reservationRequestId),
          accountId: request.sellerAccountId as AccountId,
          itemId: request.inventoryItemId,
          quantity: request.quantity,
          reason: "Ordering commitment",
          notes: null,
          purpose: "order",
          sourceRef: {
            orderId,
            reservationRequestId: request.reservationRequestId,
          },
          expiresAt: null,
        },
        context,
      );
    }
    holdId = holdPlan.holdId;
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

  const reservationPlan = await services.reservations.planConfirmation(
    {
      reservationRequestId: request.reservationRequestId,
      orderId,
      sellerAccountId: request.sellerAccountId,
      inventoryItemId: request.inventoryItemId,
      quantity: request.quantity,
      holdId,
    },
    context,
  );

  if (reservationPlan.kind === "already-resolved") {
    return;
  }

  const appends = [...(holdPlan.kind === "append" ? [holdPlan.append] : []), reservationPlan.append];
  const results = await services.appendToStreams(appends);
  recordCommittedEvents(results.flatMap((result) => result.storedEvents));
}

function isTerminalHoldPlacementFailure(error: unknown): error is InventoryHoldPlacementError {
  return (
    error instanceof InventoryHoldPlacementError &&
    (error.kind === "insufficient-available-quantity" || error.kind === "inventory-item-missing")
  );
}

function isTransientHoldPlacementFailure(error: unknown): error is InventoryHoldPlacementError {
  return error instanceof InventoryHoldPlacementError && error.kind === "inventory-item-projection-missing";
}
