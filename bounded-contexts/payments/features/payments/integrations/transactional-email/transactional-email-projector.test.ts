import { describe, expect, it, vi } from "vitest";
import { projectPaymentEventToTransactionalEmail } from "./transactional-email-projector";

describe("payments transactional email projector", () => {
  it("uses order input buyer email to enqueue payment capture email", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: "buyer@example.com" }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectPaymentEventToTransactionalEmail(db, outbox, {
      id: "evt_pay",
      type: "payments.payment-captured",
      globalPosition: "10",
      trace: { traceId: "trace_pay" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: {
        paymentId: "pay_123",
        orderIds: ["ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"],
        amount: "20.00",
        currencyCode: "USD",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification.mock.calls[0]?.[0]).toMatchObject({
      message: {
        messageType: "payments.payment-captured",
        channels: [{ channel: "email", to: [{ email: "buyer@example.com" }] }],
      },
      source: {
        sourceEventId: "evt_pay",
        sourceGlobalPosition: "10",
      },
    });
  });

  it("does not enqueue payment failure email because decline recovery stays on the payment page", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: "buyer@example.com" }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectPaymentEventToTransactionalEmail(db, outbox, {
      id: "evt_pay_failed",
      type: "payments.payment-failed",
      globalPosition: "11",
      trace: { traceId: "trace_pay_failed" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: { paymentId: "pay_123", orderIds: ["ord_123"], amount: "20.00", currencyCode: "USD" },
    } as never);

    expect(db.query).not.toHaveBeenCalled();
    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });

  it("does not enqueue when no buyer email has been projected for the order", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: null }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectPaymentEventToTransactionalEmail(db, outbox, {
      id: "evt_pay",
      type: "payments.payment-captured",
      globalPosition: "10",
      trace: { traceId: "trace_pay" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: { paymentId: "pay_123", orderIds: ["ord_123"], amount: "20.00", currencyCode: "USD" },
    } as never);

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});
