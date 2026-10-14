import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as inventoryModule } from "../index";
import type { InventoryServices } from "../support/runtime-support/services";
import {
  inventoryMutationAttemptFromSource,
  withInventoryMutationAttempt,
  withInventoryMutationTargetAccount,
} from "../support/runtime-support/mutation-attempt";

function createMutationExecutor() {
  const execute: InventoryServices["mutations"]["execute"] = async (
    _family,
    _targetId,
    _accountId,
    _params,
    _context,
    work,
  ) => work();
  return vi.fn(execute);
}

function createCancellationEvent(reason: string): TransportEvent {
  return buildTransportEvent(
    "ordering.order.cancelled",
    {
      orderId: "ord_1",
      cancelledAt: "2026-03-31T01:00:00.000Z",
      reason,
      buyerEmail: "buyer@example.com",
      reservationRequests: [
        {
          reservationRequestId: "rsv_1",
          inventoryItemId: "inv_1",
          sellerAccountId: "acc_seller",
          quantity: 1,
          holdId: "hld_1",
          status: "confirmed",
        },
      ],
    },
    {
      id: "evt_order_cancelled",
      streamId: "ordering.order-ord_1",
      streamVersion: 3,
      globalPosition: "3",
      tenantId: "tenant_1",
      audit: { performedByUserId: "usr_system", forAccountId: null },
      trace: { traceId: "trace_1" },
      timing: { occurredAt: "2026-03-31T01:00:00.000Z", recordedAt: "2026-03-31T01:00:00.000Z" },
    },
  );
}

function getOrderingCancellationHandler(services: InventoryServices) {
  const subscription = (inventoryModule.buildSubscriptions?.(services) ?? []).find(
    (candidate) => candidate.subscriptionName === "inventory.order-reservation-workflow",
  );
  const handler = subscription?.handlers["ordering.order.cancelled"];

  if (!handler) {
    throw new Error("Inventory ordering cancellation subscription handler was not registered.");
  }

  return handler;
}

describe("inventory ordering cancellation subscription", () => {
  it("releases confirmed holds with the payment-deadline reason", async () => {
    const releaseHold = vi.fn(async () => ({ holdId: "hld_1", version: 2 }));
    const reservationCommandHandler = vi.fn(async () => ({ version: 2, storedEvents: [] }));
    const markPending = vi.fn();
    const executeMutation = createMutationExecutor();
    const services = {
      mutations: { execute: executeMutation },
      holds: {
        getHold: vi.fn(async () => ({ status: "active" })),
        releaseHold,
      },
      reservations: {
        getReservationState: vi.fn(async () => ({ status: "confirmed" })),
        commandHandler: reservationCommandHandler,
      },
      restockDecisions: { markPending },
      appendToStreams: vi.fn(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      projectors: [],
      pool: {},
    } as unknown as InventoryServices;

    await getOrderingCancellationHandler(services)(createCancellationEvent("payment-deadline"));

    const event = createCancellationEvent("payment-deadline");
    const attemptedContext = withInventoryMutationAttempt(
      withInventoryMutationTargetAccount(
        { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
        "acc_seller",
      ),
      inventoryMutationAttemptFromSource(event.id, "release/rsv_1"),
    );
    expect(executeMutation).toHaveBeenCalledExactlyOnceWith(
      "hold-release",
      "hld_1",
      "acc_seller",
      { accountId: "acc_seller", holdId: "hld_1", releaseReason: "payment-deadline" },
      attemptedContext,
      expect.any(Function),
    );
    expect(releaseHold).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        holdId: "hld_1",
        releaseReason: "payment-deadline",
      }),
      expect.anything(),
    );
    expect(reservationCommandHandler).toHaveBeenCalledWith({
      streamId: "inventory.reservation-rsv_1",
      command: {
        type: "ReleaseInventoryReservation",
        releasedAt: "2026-03-31T01:00:00.000Z",
        releaseReason: "payment-deadline",
      },
      context: expect.objectContaining({
        tenantId: "tenant_1",
      }),
    });
    expect(markPending).not.toHaveBeenCalled();
  });

  it("routes consumed holds to a restock decision instead of releasing stock", async () => {
    const releaseHold = vi.fn();
    const reservationCommandHandler = vi.fn();
    const markPending = vi.fn(async () => ({ decisionId: "rstk_1", version: 1 }));
    const executeMutation = createMutationExecutor();
    const services = {
      mutations: { execute: executeMutation },
      holds: {
        getHold: vi.fn(async () => ({ status: "consumed" })),
        releaseHold,
      },
      reservations: {
        getReservationState: vi.fn(async () => ({ status: "confirmed" })),
        commandHandler: reservationCommandHandler,
      },
      restockDecisions: { markPending },
      appendToStreams: vi.fn(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      projectors: [],
      pool: {},
    } as unknown as InventoryServices;

    await getOrderingCancellationHandler(services)(createCancellationEvent("buyer-returned"));

    expect(markPending).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        orderId: "ord_1",
        itemId: "inv_1",
        quantity: 1,
        reservationRequestId: "rsv_1",
        source: "order-cancelled-after-dispatch",
        shipmentId: null,
        returnReason: "buyer-returned",
        pendingAt: "2026-03-31T01:00:00.000Z",
      },
      expect.objectContaining({
        tenantId: "tenant_1",
      }),
    );
    expect(releaseHold).not.toHaveBeenCalled();
    expect(executeMutation).not.toHaveBeenCalled();
    expect(reservationCommandHandler).not.toHaveBeenCalled();
  });
});
