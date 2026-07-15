import { describe, expect, it, vi } from "vitest";
import { buildOrderingTransactionalEmailProjectionHandlers } from "./transactional-email-projector";

async function projectOrderingEventToTransactionalEmail(
  outbox: Parameters<typeof buildOrderingTransactionalEmailProjectionHandlers>[0],
  event: never,
) {
  const handlers = buildOrderingTransactionalEmailProjectionHandlers(outbox);
  await handlers[(event as { type: string }).type]?.(event);
}

describe("ordering transactional email projector", () => {
  it("enqueues only when order.created events include a buyer email snapshot", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };
    await projectOrderingEventToTransactionalEmail(outbox, {
      id: "evt_2",
      type: "ordering.order.created",
      globalPosition: "2",
      trace: { traceId: "req_2" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        orderId: "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        sourceType: "offer-acceptance",
        totalAmount: "10.00",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);
    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect((outbox.enqueueNotification.mock.calls[0]?.[0] as { source: unknown } | undefined)?.source).toMatchObject({
      sourceEventId: "evt_2",
      sourceGlobalPosition: "2",
    });
  });

  it("does not enqueue for checkout-created purchases before payment capture", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };
    await projectOrderingEventToTransactionalEmail(outbox, {
      id: "evt_checkout_order",
      type: "ordering.order.created",
      globalPosition: "3",
      trace: { traceId: "req_3" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        orderId: "ord_checkout",
        sourceType: "cart-checkout",
        totalAmount: "10.00",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });

  it("enqueues buyer notification for payment-deadline cancellation", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };
    await projectOrderingEventToTransactionalEmail(outbox, {
      id: "evt_deadline_cancelled",
      type: "ordering.order.cancelled",
      globalPosition: "4",
      trace: { traceId: "req_deadline" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        orderId: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        reason: "payment-deadline",
        buyerEmail: " buyer@example.com ",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect((outbox.enqueueNotification.mock.calls[0]?.[0] as { message: unknown } | undefined)?.message).toMatchObject({
      messageType: "ordering.order.cancelled.payment-deadline",
      templateData: {
        orderReference: "ORD-Q69G5FAV",
        reorderHref: "/marketplace?reorderFrom=ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
  });

  it("does not enqueue cancellation notification for non-deadline cancellations", async () => {
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };
    await projectOrderingEventToTransactionalEmail(outbox, {
      id: "evt_buyer_cancelled",
      type: "ordering.order.cancelled",
      globalPosition: "5",
      trace: { traceId: "req_buyer_cancelled" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        orderId: "ord_buyer_cancelled",
        reason: "buyer-cancelled",
        buyerEmail: "buyer@example.com",
      },
    } as never);

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});
