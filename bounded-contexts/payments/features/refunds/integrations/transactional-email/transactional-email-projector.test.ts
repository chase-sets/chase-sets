import { describe, expect, it, vi } from "vitest";
import { buildRefundTransactionalEmailProjectionHandlers } from "./transactional-email-projector";

async function projectRefundEventToTransactionalEmail(
  db: Parameters<typeof buildRefundTransactionalEmailProjectionHandlers>[0],
  outbox: Parameters<typeof buildRefundTransactionalEmailProjectionHandlers>[1],
  event: never,
) {
  const handlers = buildRefundTransactionalEmailProjectionHandlers(db, outbox);
  await handlers[(event as { type: string }).type]?.(event);
}

describe("refund transactional email projector", () => {
  it("uses order input buyer email to enqueue refund issued email", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: "buyer@example.com" }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectRefundEventToTransactionalEmail(db, outbox, {
      id: "evt_refund",
      type: "payments.refund-issued",
      globalPosition: "12",
      trace: { traceId: "trace_refund" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: {
        refundId: "rfd_123",
        paymentId: "pay_123",
        orderIds: ["ord_123"],
        amount: "12.00",
        currencyCode: "USD",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification.mock.calls[0]?.[0]).toMatchObject({
      message: {
        messageType: "payments.refund-issued",
        channels: [{ channel: "email", to: [{ email: "buyer@example.com" }] }],
      },
      source: {
        sourceEventId: "evt_refund",
        sourceGlobalPosition: "12",
      },
    });
  });

  it("uses the same buyer email source to enqueue refund failure email", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: "buyer@example.com" }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectRefundEventToTransactionalEmail(db, outbox, {
      id: "evt_refund_failed",
      type: "payments.refund-failed",
      globalPosition: "13",
      trace: { traceId: "trace_refund_failed" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: {
        refundId: "rfd_123",
        paymentId: "pay_123",
        orderIds: ["ord_123"],
        amount: "12.00",
        currencyCode: "USD",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification.mock.calls[0]?.[0]).toMatchObject({
      message: {
        messageType: "payments.refund-failed",
        templateId: "refund_failed",
        channels: [{ channel: "email", to: [{ email: "buyer@example.com" }] }],
      },
    });
  });

  it("does not enqueue when no buyer email has been projected for the order", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectRefundEventToTransactionalEmail(db, outbox, {
      id: "evt_refund",
      type: "payments.refund-issued",
      globalPosition: "12",
      trace: { traceId: "trace_refund" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: {
        refundId: "rfd_123",
        paymentId: "pay_123",
        orderIds: ["ord_123"],
        amount: "12.00",
        currencyCode: "USD",
      },
    } as never);

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});
