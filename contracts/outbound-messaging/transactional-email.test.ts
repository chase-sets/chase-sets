import type { NotificationMessage } from ".";
import { describe, expect, it, vi } from "vitest";
import { defineTransactionalEmail } from "./transactional-email";

function message(correlationId: string, email = "buyer@example.com"): NotificationMessage {
  return {
    messageType: "ordering.order.created",
    criticality: "commerce",
    title: "Order confirmed",
    body: "Order confirmed",
    templateId: "order_confirmed",
    templateVersion: 1,
    locale: "en",
    templateData: {},
    channels: [{ channel: "email", to: [{ email }] }],
    idempotencyKey: "ordering:order_confirmed:ord_1",
    correlationId,
    actor: { userId: null, accountId: null },
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "ordering.order.created",
    streamId: "ordering.order-ord_1",
    streamVersion: 1,
    globalPosition: "12",
    tenantId: "tenant_1",
    data: { email: " buyer@example.com " },
    metadata: {},
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    trace: { traceId: "trace_1" },
    timing: {
      occurredAt: "2026-07-14T00:00:00.000Z",
      recordedAt: "2026-07-14T00:00:01.000Z",
    },
    ...overrides,
  } as never;
}

describe("defineTransactionalEmail", () => {
  it("owns correlation and source-envelope construction", async () => {
    const enqueueNotification = vi.fn(async () => undefined);
    const handlers = defineTransactionalEmail<{ email: string }, string, "ordering.order.created">({
      outbox: { enqueueNotification },
      projectionName: "ordering-email-projection",
      on: "ordering.order.created",
      recipient: (data) => data.email.trim() || null,
      template: (_data, context) => message(context.correlationId, context.recipient),
    });

    await handlers["ordering.order.created"]?.(event());

    expect(enqueueNotification).toHaveBeenCalledWith({
      message: message("trace_1"),
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-email-projection",
        occurredAt: "2026-07-14T00:00:00.000Z",
      },
    });
  });

  it("falls back to the event id and skips before resolving a recipient", async () => {
    const enqueueNotification = vi.fn(async () => undefined);
    const recipient = vi.fn(() => "buyer@example.com");
    const template = vi.fn((_data, context: { correlationId: string }) => message(context.correlationId));
    const handlers = defineTransactionalEmail<{ suppressed: boolean }, string, "ordering.order.created">({
      outbox: { enqueueNotification },
      projectionName: "ordering-email-projection",
      on: "ordering.order.created",
      skipWhen: (data) => data.suppressed,
      recipient,
      template,
    });

    await handlers["ordering.order.created"]?.(
      event({ data: { suppressed: true }, trace: {}, type: "ordering.order.created" }),
    );

    expect(recipient).not.toHaveBeenCalled();
    expect(template).not.toHaveBeenCalled();
    expect(enqueueNotification).not.toHaveBeenCalled();

    await handlers["ordering.order.created"]?.(
      event({ data: { suppressed: false }, trace: {}, type: "ordering.order.created" }),
    );

    expect(template).toHaveBeenCalledWith({ suppressed: false }, expect.objectContaining({ correlationId: "evt_1" }));
  });

  it("enqueues scheduled sequences and runs cleanup only after every delivery", async () => {
    const calls: string[] = [];
    const handlers = defineTransactionalEmail<{ email: string }, string, "ordering.order.created">({
      outbox: {
        enqueueNotification: vi.fn(async (input) => {
          calls.push(input.availableAt ?? "now");
        }),
      },
      projectionName: "ordering-email-projection",
      on: "ordering.order.created",
      recipient: async (data) => data.email,
      template: (_data, context) => [
        { message: message(context.correlationId, context.recipient), availableAt: "2026-07-14T00:00:00.000Z" },
        { message: message(context.correlationId, context.recipient), availableAt: "2026-07-15T00:00:00.000Z" },
      ],
      afterEnqueue: async () => {
        calls.push("cleanup");
      },
    });

    await handlers["ordering.order.created"]?.(event({ trace: {} }));

    expect(calls).toEqual(["2026-07-14T00:00:00.000Z", "2026-07-15T00:00:00.000Z", "cleanup"]);
  });
});
