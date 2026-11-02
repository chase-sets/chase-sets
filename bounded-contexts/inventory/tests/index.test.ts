import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as inventoryModule } from "../index";
import type { InventoryServices } from "../support/runtime-support/services";

type HoldDouble = { holdId: string; itemId: string; quantity: number; status: "active" | "released" | "consumed" };

/**
 * Inventory's own module wiring (`index.ts`) for buyer-owned cancellation: every
 * `ordering.order.cancelled` releases its confirmed holds through the system
 * release authority. Stock is measured as on-hand less active holds, so each
 * assertion is about quantity returned to sale, not a status flag.
 */
function inventoryDouble(holds: readonly HoldDouble[], onHand: Readonly<Record<string, number>>) {
  const byId = new Map(holds.map((hold) => [hold.holdId, { ...hold }]));
  const reservationStatus = new Map<string, "confirmed" | "released">();
  const execute: InventoryServices["mutations"]["execute"] = async (
    _family,
    _targetId,
    _accountId,
    _params,
    _context,
    work,
  ) => work();
  const services = {
    mutations: { execute: vi.fn(execute) },
    holds: {
      getHold: vi.fn(async (holdId: string) => byId.get(holdId) ?? null),
      releaseHold: vi.fn(async ({ holdId }: { holdId: string }) => {
        const hold = byId.get(holdId)!;
        hold.status = "released";
        return { holdId, version: 2 };
      }),
    },
    reservations: {
      getReservationState: vi.fn(async (reservationRequestId: string) => ({
        status: reservationStatus.get(reservationRequestId) ?? "confirmed",
      })),
      commandHandler: vi.fn(async ({ streamId }: { streamId: string }) => {
        reservationStatus.set(streamId.replace("inventory.reservation-", ""), "released");
        return { version: 2, storedEvents: [] };
      }),
    },
    restockDecisions: { markPending: vi.fn() },
    appendToStreams: vi.fn(),
    db: { query: vi.fn(async () => ({ rows: [] })) },
    projectors: [],
    pool: {},
  } as unknown as InventoryServices;
  const available = () =>
    Object.fromEntries(
      Object.entries(onHand).map(([itemId, quantity]) => [
        itemId,
        quantity -
          [...byId.values()]
            .filter((hold) => hold.itemId === itemId && hold.status === "active")
            .reduce((sum, hold) => sum + hold.quantity, 0),
      ]),
    );
  return { services, available };
}

function buyerCancelledEvent(orderId: string, holds: readonly HoldDouble[], eventId = `evt_${orderId}_cancelled`) {
  return buildTransportEvent(
    "ordering.order.cancelled",
    {
      orderId,
      cancelledAt: "2026-10-25T00:30:00.000Z",
      reason: "buyer-cancelled",
      buyerEmail: null,
      buyerAccountId: "acc_collector",
      statusBeforeCancellation: "pending-payment",
      reservationRequests: holds.map((hold) => ({
        reservationRequestId: `rsv_${hold.holdId}`,
        inventoryItemId: hold.itemId,
        sellerAccountId: "acc_seller",
        quantity: hold.quantity,
        holdId: hold.holdId,
        status: "confirmed",
      })),
    },
    {
      id: eventId,
      streamId: `ordering.order-${orderId}`,
      streamVersion: 4,
      globalPosition: "4",
      tenantId: "tenant_1",
      audit: { performedByUserId: "usr_collector", forAccountId: "acc_collector" },
      trace: { traceId: "trace_1" },
      timing: { occurredAt: "2026-10-25T00:30:00.000Z", recordedAt: "2026-10-25T00:30:00.000Z" },
    },
  ) as TransportEvent;
}

function cancellationHandler(services: InventoryServices) {
  const handler = (inventoryModule.buildSubscriptions?.(services) ?? []).find(
    (subscription) => subscription.subscriptionName === "inventory.order-reservation-workflow",
  )?.handlers["ordering.order.cancelled"];
  if (!handler) throw new Error("Inventory did not register its ordering.order.cancelled handler.");
  return handler;
}

describe("inventory module release of buyer-cancelled pending orders", () => {
  const firstOrderHolds: HoldDouble[] = [
    { holdId: "hld_a1", itemId: "inv_a", quantity: 2, status: "active" },
    { holdId: "hld_b1", itemId: "inv_b", quantity: 1, status: "active" },
  ];
  const secondOrderHolds: HoldDouble[] = [{ holdId: "hld_a2", itemId: "inv_a", quantity: 1, status: "active" }];

  it("returns every confirmed hold of each cancelled order to available stock", async () => {
    const inventory = inventoryDouble([...firstOrderHolds, ...secondOrderHolds], { inv_a: 4, inv_b: 1 });
    const handle = cancellationHandler(inventory.services);

    expect(inventory.available()).toEqual({ inv_a: 1, inv_b: 0 });
    await handle(buyerCancelledEvent("ord_first", firstOrderHolds));
    expect(inventory.available()).toEqual({ inv_a: 3, inv_b: 1 });
    await handle(buyerCancelledEvent("ord_second", secondOrderHolds));
    expect(inventory.available()).toEqual({ inv_a: 4, inv_b: 1 });

    expect(inventory.services.holds.releaseHold).toHaveBeenCalledTimes(3);
    expect(vi.mocked(inventory.services.holds.releaseHold).mock.calls.map(([intent]) => intent)).toEqual([
      { accountId: "acc_seller", holdId: "hld_a1", releaseReason: "order-cancelled" },
      { accountId: "acc_seller", holdId: "hld_b1", releaseReason: "order-cancelled" },
      { accountId: "acc_seller", holdId: "hld_a2", releaseReason: "order-cancelled" },
    ]);
  });

  it("releases nothing more when the same cancellation is delivered again", async () => {
    const inventory = inventoryDouble(firstOrderHolds, { inv_a: 2, inv_b: 1 });
    const handle = cancellationHandler(inventory.services);
    const event = buyerCancelledEvent("ord_first", firstOrderHolds);

    await handle(event);
    await handle(event);

    expect(inventory.available()).toEqual({ inv_a: 2, inv_b: 1 });
    expect(inventory.services.holds.releaseHold).toHaveBeenCalledTimes(2);
  });

  it("leaves a dispatched (consumed) hold reserved and routes it to a restock decision", async () => {
    const consumed: HoldDouble[] = [{ holdId: "hld_shipped", itemId: "inv_a", quantity: 1, status: "consumed" }];
    const inventory = inventoryDouble(consumed, { inv_a: 1 });

    await cancellationHandler(inventory.services)(buyerCancelledEvent("ord_shipped", consumed));

    expect(inventory.services.holds.releaseHold).not.toHaveBeenCalled();
    expect(inventory.services.restockDecisions.markPending).toHaveBeenCalledTimes(1);
  });
});
