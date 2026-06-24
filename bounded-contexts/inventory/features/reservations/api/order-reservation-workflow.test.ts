import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventoryHoldServices } from "../../holds/api/runtime";
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
    createHold?: InventoryHoldServices["createHold"];
    commandHandler?: InventoryReservationServices["commandHandler"];
  }> = {},
) {
  let status: InventoryReservationState["status"] = null;
  const holds = {
    commandHandler: vi.fn(),
    createHold:
      options.createHold ??
      vi.fn(async (params) => ({
        holdId: params.holdId ?? ("hld_generated" as InventoryHoldId),
        version: 1,
      })),
    releaseHold: vi.fn(),
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
    projectors: [],
  } satisfies InventoryReservationServices;

  return { holds, reservations };
}

describe("order inventory reservation workflow", () => {
  it("confirms a reservation with a deterministic hold id and ignores duplicate delivery", async () => {
    const services = createServices();

    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });
    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });

    expect(services.holds.createHold).toHaveBeenCalledTimes(1);
    expect(services.holds.createHold).toHaveBeenCalledWith(
      expect.objectContaining({
        holdId: orderReservationHoldId(request.reservationRequestId),
        accountId: request.sellerAccountId as AccountId,
        itemId: request.inventoryItemId,
        quantity: request.quantity,
      }),
      context,
    );
    expect(services.reservations.commandHandler).toHaveBeenCalledTimes(1);
    expect(services.reservations.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "ConfirmInventoryReservation",
          holdId: orderReservationHoldId(request.reservationRequestId),
        }),
      }),
    );
  });

  it("uses the same hold id when confirmation is retried after a transient failure", async () => {
    let attempts = 0;
    const services = createServices({
      commandHandler: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary commit failure");
        }
        return {
          state: reservationState("confirmed"),
          version: 1,
          newEvents: [],
          storedEvents: [],
        } as never;
      }),
    });

    await expect(reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context })).rejects.toThrow(
      "temporary commit failure",
    );
    await reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context });

    expect(services.holds.createHold).toHaveBeenCalledTimes(2);
    expect(services.holds.createHold).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ holdId: orderReservationHoldId(request.reservationRequestId) }),
      context,
    );
    expect(services.holds.createHold).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ holdId: orderReservationHoldId(request.reservationRequestId) }),
      context,
    );
  });

  it("rejects a reservation only for terminal stock exhaustion", async () => {
    const services = createServices({
      createHold: vi.fn(async () => {
        throw new InventoryDomainError("Holds cannot exceed the available quantity for an inventory item.");
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

  it("does not cancel an order for transient inventory projection misses", async () => {
    const services = createServices({
      createHold: vi.fn(async () => {
        throw new InventoryDomainError("Inventory item not found.");
      }),
    });

    await expect(reserveOrderInventoryRequest(services, { orderId: "ord_1", request, context })).rejects.toMatchObject({
      message: "Inventory item not found.",
      projectionFailureKind: "transient",
    });
    expect(services.reservations.commandHandler).not.toHaveBeenCalled();
  });
});
