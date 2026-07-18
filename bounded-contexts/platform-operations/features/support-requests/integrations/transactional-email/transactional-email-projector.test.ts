import { describe, expect, it, vi } from "vitest";
import { buildSupportRequestTransactionalEmailProjectionHandlers } from "./transactional-email-projector";

async function projectSupportRequestEventToTransactionalEmail(
  db: Parameters<typeof buildSupportRequestTransactionalEmailProjectionHandlers>[0],
  outbox: Parameters<typeof buildSupportRequestTransactionalEmailProjectionHandlers>[1],
  event: never,
) {
  const handlers = buildSupportRequestTransactionalEmailProjectionHandlers(db, outbox);
  await handlers[(event as { type: string }).type]?.(event);
}

describe("support request transactional email projector", () => {
  it("uses order source buyer email to enqueue support request email", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: "buyer@example.com" }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectSupportRequestEventToTransactionalEmail(db, outbox, {
      id: "evt_support",
      type: "support.support-request.opened",
      globalPosition: "14",
      trace: { traceId: "trace_support" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: {
        supportRequestId: "sup_123",
        orderId: "ord_123",
        flowType: "item-not-as-described",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification.mock.calls[0]?.[0]).toMatchObject({
      message: {
        messageType: "support.support-request.opened",
        channels: [{ channel: "email", to: [{ email: "buyer@example.com" }] }],
      },
      source: {
        sourceEventId: "evt_support",
        sourceGlobalPosition: "14",
      },
    });
  });

  it("notifies the buyer when Honor Offline opens seller-cannot-fulfill support", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: "buyer@example.com", buyer_account_id: "acc_buyer" }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectSupportRequestEventToTransactionalEmail(db, outbox, {
      id: "evt_honor_offline_support",
      type: "support.support-request.opened",
      globalPosition: "16",
      trace: { traceId: "trace_honor_offline" },
      timing: { occurredAt: "2026-07-17T12:00:00.000Z", recordedAt: "2026-07-17T12:00:01.000Z" },
      data: {
        supportRequestId: "sup_honor_offline",
        orderId: "ord_1",
        flowType: "seller-cannot-fulfill",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "support.support-request.opened",
          recipientAccountId: "acc_buyer",
          templateData: expect.objectContaining({ flowType: "seller-cannot-fulfill", orderId: "ord_1" }),
        }),
      }),
    );
  });

  it("uses order source buyer email to enqueue support request resolution email", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: "buyer@example.com" }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectSupportRequestEventToTransactionalEmail(db, outbox, {
      id: "evt_support_resolved",
      type: "support.support-request.resolved",
      globalPosition: "15",
      trace: { traceId: "trace_support_resolved" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: {
        supportRequestId: "sup_123",
        orderId: "ord_123",
        flowType: "item-not-as-described",
        resolution: { resolutionType: "partial-refund", summary: "Adjudicated partial refund." },
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification.mock.calls[0]?.[0]).toMatchObject({
      message: {
        messageType: "support.support-request.resolved",
        templateId: "support_request_resolved",
        templateData: { resolutionType: "partial-refund", resolutionSummary: "Adjudicated partial refund." },
        channels: [{ channel: "email", to: [{ email: "buyer@example.com" }] }],
      },
    });
  });

  it("does not enqueue when no buyer email has been projected for the order", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ buyer_email: " " }] })),
    };
    const outbox = { enqueueNotification: vi.fn(async (_input: unknown) => undefined) };

    await projectSupportRequestEventToTransactionalEmail(db, outbox, {
      id: "evt_support",
      type: "support.support-request.opened",
      globalPosition: "14",
      trace: { traceId: "trace_support" },
      timing: { occurredAt: "2026-05-31T00:00:00.000Z", recordedAt: "2026-05-31T00:00:01.000Z" },
      data: {
        supportRequestId: "sup_123",
        orderId: "ord_123",
        flowType: "item-not-as-described",
      },
    } as never);

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});
