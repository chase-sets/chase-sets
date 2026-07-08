import { describe, expect, it, vi } from "vitest";
import type { AppendToStreamsResult } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { InventoryHoldPlacementError, type InventoryHoldServices } from "../../holds/api/runtime";
import { InventoryDomainError, type InventoryHoldId } from "../../../support/runtime-support/common";
import type { InventoryReservationState } from "../domain/domain";
import type { InventoryReservationServices } from "./runtime";
import { orderReservationHoldId, reserveOrderInventoryRequest } from "./order-reservation-workflow";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_buyer" as never,
  },
};

const request = {
  reservationRequestId: "rsv_order_1",
  sellerAccountId: "acc_seller",
  inventoryItemId: "inv_1",
  quantity: 1,
};

function reservationState(status: InventoryReservationState["status"] = null): InventoryReservationState {
  return {
    reservationRequestId: status ? request.reservationRequestId : null,
    orderId: status ? "ord_1" : null,
    sellerAccountId: status ? request.sellerAccountId : null,
    inventoryItemId: status ? request.inventoryItemId : null,
    quantity: status ? request.quantity : 0,
    holdId: status === "confirmed" ? orderReservationHoldId(request.reservationRequestId) : null,
    status,
    rejectionReason: status === "rejected" ? "not available" : null,
    releasedAt: null,
  };
}

function createServices(
  options: Readonly<{
    planCreateHold?: InventoryHoldServices["planCreateHold"];
    planConvertCheckoutHold?: InventoryHoldServices["planConvertCheckoutHold"];
    commandHandler?: InventoryReservationServices["commandHandler"];
    appendToStreams?: (inputs: readonly AppendToStreamInput[]) => Promise<readonly AppendToStreamsResult[]>;
  }> = {},
) {
  let status: InventoryReservationState["status"] = null;
  const planCreateHold =
    options.planCreateHold ??
    vi.fn<InventoryHoldServices["planCreateHold"]>(async (params, planContext) => {
      const holdId = params.holdId ?? ("hld_generated" as InventoryHoldId);
      return {
        kind: "append",
        holdId,
        append: appendInput(`inventory.hold-${holdId}`, "inventory.hold.placed", { holdId }, planContext),
      };
    });
  const planConfirmation = vi.fn<InventoryReservationServices["planConfirmation"]>(async (params, planContext) => ({
    kind: "append",
    append: appendInput(
      `inventory.reservation-${params.reservationRequestId}`,
      "inventory.reservation.confirmed",
      {
        reservationRequestId: params.reservationRequestId,
        orderId: params.orderId,
        sellerAccountId: params.sellerAccountId,
        inventoryItemId: params.inventoryItemId,
        quantity: params.quantity,
        holdId: params.holdId,
      },
      planContext,
    ),
  }));
  const holds = {
    commandHandler: vi.fn(),
    planCreateHold,
    planConvertCheckoutHold:
      options.planConvertCheckoutHold ??
      vi.fn<InventoryHoldServices["planConvertCheckoutHold"]>(async (params, planContext) => ({
        kind: "append",
        holdId: params.holdId,
        append: appendInput(
          `inventory.hold-${params.holdId}`,
          "inventory.hold.converted",
          { holdId: params.holdId },
          planContext,
        ),
      })),
    createHold: vi.fn(async (params) => ({
      holdId: params.holdId ?? ("hld_generated" as InventoryHoldId),
      version: 1,
    })),
    releaseHold: vi.fn(),
    expireDueCheckoutHolds: vi.fn(),
    extendCheckoutHold: vi.fn(),
    getHold: vi.fn(),
    projectors: [],
  } satisfies InventoryHoldServices;
  const reservations = {
    commandHandler:
      options.commandHandler ??
      vi.fn(async (input) => {
        status = input.command.type === "ConfirmInventoryReservation" ? "confirmed" : "rejected";
        return {
          state: reservationState(status),
          version: 1,
          newEvents: [],
          storedEvents: [],
        } as never;
      }),
    getReservation: vi.fn(),
    getReservationState: vi.fn(async () => reservationState(status)),
    planConfirmation,
    projectors: [],
  } satisfies InventoryReservationServices;

  const appendToStreams =
    options.appendToStreams ??
    vi.fn(async (inputs: readonly AppendToStreamInput[]) => {
      status = "confirmed";
      return inputs.map((input, index) => ({
        streamId: input.streamId,
        storedEvents: [
          {
            eventId: `evt_${index + 1}` as never,
            streamId: input.streamId,
            streamVersion: 1,
            globalPosition: String(index + 1) as never,
            tenantId: input.context.tenantId,
            eventType: input.events[0]?.eventType ?? "inventory.noop",
            payload: input.events[0]?.payload ?? {},
            metadata: {},
            occurredAt: "2026-07-06T00:00:00.000Z" as never,
            recordedAt: "2026-07-06T00:00:00.000Z" as never,
            performedByUserId: input.context.audit.performedByUserId,
            forAccountId: input.context.audit.forAccountId,
          },
        ],
      }));
    });

  return { holds, reservations, appendToStreams };
}

describe("order inventory reservation workflow", () => {
  it("derives hold ids from stream-safe reservation request ids without lossy normalization", () => {
    expect(orderReservationHoldId(" rsv_01KZ9H8R31DDB5YA9PZMN7P36M ")).toBe(
      "hld_order_reservation_rsv_01KZ9H8R31DDB5YA9PZMN7P36M",
    );
    expect(() => orderReservationHoldId("rsv_order-1")).toThrow(InventoryDomainError);
  });

  it("confirms a reservation with a deterministic hold id and ignores duplicate delivery", async () => {
    const services = createServices();

    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });
    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });

    expect(services.holds.planCreateHold).toHaveBeenCalledTimes(1);
    expect(services.holds.planCreateHold).toHaveBeenCalledWith(
      expect.objectContaining({
        holdId: orderReservationHoldId(request.reservationRequestId),
        accountId: request.sellerAccountId as AccountId,
        itemId: request.inventoryItemId,
        quantity: request.quantity,
        purpose: "order",
        sourceRef: {
          orderId: "ord_1",
          reservationRequestId: request.reservationRequestId,
        },
        expiresAt: null,
      }),
      context,
    );
    expect(services.reservations.planConfirmation).toHaveBeenCalledTimes(1);
    expect(services.reservations.planConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        holdId: orderReservationHoldId(request.reservationRequestId),
      }),
      context,
    );
    expect(services.appendToStreams).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ streamId: `inventory.hold-${orderReservationHoldId(request.reservationRequestId)}` }),
        expect.objectContaining({ streamId: `inventory.reservation-${request.reservationRequestId}` }),
      ]),
    );
  });

  it("uses the same hold id when the dual append is retried after a transient failure", async () => {
    let attempts = 0;
    const services = createServices({
      appendToStreams: vi.fn(async (inputs: readonly AppendToStreamInput[]) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary commit failure");
        }
        return inputs.map((input) => ({ streamId: input.streamId, storedEvents: [] }));
      }),
    });

    await expect(reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context })).rejects.toThrow(
      "temporary commit failure",
    );
    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });

    expect(services.holds.planCreateHold).toHaveBeenCalledTimes(2);
    expect(services.holds.planCreateHold).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ holdId: orderReservationHoldId(request.reservationRequestId) }),
      context,
    );
    expect(services.holds.planCreateHold).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ holdId: orderReservationHoldId(request.reservationRequestId) }),
      context,
    );
  });

  it("converts a supplied checkout hold and confirms the reservation without a fresh placement", async () => {
    const services = createServices();
    const checkoutRequest = {
      ...request,
      holdId: "hld_checkout_session_line_1",
    };

    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request: checkoutRequest, context });

    expect(services.holds.planCreateHold).not.toHaveBeenCalled();
    expect(services.holds.planConvertCheckoutHold).toHaveBeenCalledWith(
      {
        holdId: "hld_checkout_session_line_1",
        accountId: request.sellerAccountId as AccountId,
        itemId: request.inventoryItemId,
        quantity: request.quantity,
        orderId: "ord_1",
        reservationRequestId: request.reservationRequestId,
      },
      context,
    );
    expect(services.reservations.planConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        holdId: "hld_checkout_session_line_1",
      }),
      context,
    );
  });

  it("rejects a reservation for terminal stock exhaustion", async () => {
    const services = createServices({
      planCreateHold: vi.fn(async () => {
        throw new InventoryHoldPlacementError(
          "insufficient-available-quantity",
          "Holds cannot exceed the available quantity for an inventory item.",
        );
      }),
    });

    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });

    expect(services.reservations.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "RejectInventoryReservation",
          reason: "Holds cannot exceed the available quantity for an inventory item.",
        }),
      }),
    );
  });

  it("rejects a reservation for terminal missing inventory items", async () => {
    const services = createServices({
      planCreateHold: vi.fn(async () => {
        throw new InventoryHoldPlacementError("inventory-item-missing", "Inventory item not found.");
      }),
    });

    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });

    expect(services.reservations.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "RejectInventoryReservation",
          reason: "Inventory item not found.",
        }),
      }),
    );
  });

  it("does not cancel an order for transient inventory projection misses", async () => {
    const services = createServices({
      planCreateHold: vi.fn(async () => {
        throw new InventoryHoldPlacementError("inventory-item-projection-missing", "Inventory item not found.");
      }),
    });

    await expect(reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context })).rejects.toMatchObject({
      message: "Inventory item not found.",
      projectionFailureKind: "transient",
    });
    expect(services.reservations.commandHandler).not.toHaveBeenCalled();
  });
});

function appendInput(
  streamId: string,
  eventType: string,
  payload: JsonObject,
  inputContext: EventStoreContext,
): AppendToStreamInput {
  return {
    streamId,
    expectedVersion: 0,
    events: [
      {
        eventType,
        payload,
      },
    ],
    context: inputContext,
  };
}
