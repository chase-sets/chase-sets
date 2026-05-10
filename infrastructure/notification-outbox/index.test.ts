import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedNotificationDelivery,
  NotificationMessage,
  NotificationOutboxStore,
} from "@chase-sets/notifications";
import {
  createNotificationOutboxDispatcher,
  createPostgresNotificationOutbox,
  notificationOutboxSchemaSql,
} from "./index";

const message: NotificationMessage = {
  messageType: "ordering.order.created",
  criticality: "commerce",
  title: "Order confirmed",
  body: "Order ord_1 is confirmed.",
  actionHref: "/account/purchases/ord_1",
  templateId: "order_confirmed",
  templateVersion: 1,
  locale: "en",
  templateData: { orderId: "ord_1" },
  channels: [
    { channel: "email", to: [{ email: "buyer@example.com" }] },
    {
      channel: "web",
      recipient: { accountId: "acc_buyer" as never },
      actionHref: "/account/purchases/ord_1",
    },
  ],
  idempotencyKey: "ordering:order_confirmed:ord_1",
  correlationId: "req_1",
  actor: { userId: null, accountId: null },
};

describe("notification outbox", () => {
  it("records one delivery per requested channel", async () => {
    const queries: unknown[][] = [];
    const db = {
      query: vi.fn(async (_sql: string, values?: readonly unknown[]) => {
        queries.push([...(values ?? [])]);
        return { rows: [], rowCount: 1 };
      }),
    };
    const outbox = createPostgresNotificationOutbox({
      db,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    await outbox.enqueueNotification({
      message,
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-order-notification-projection",
        occurredAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(queries[0]?.[0]).toBe("ordering:order_confirmed:ord_1:email:1");
    expect(queries[1]?.[0]).toBe("ordering:order_confirmed:ord_1:web:2");
    expect(notificationOutboxSchemaSql).toContain("notification_outbox");
  });

  it("dispatches claimed deliveries through their channel adapters", async () => {
    const delivery: ClaimedNotificationDelivery = {
      outboxId: "1",
      deliveryId: "ordering:order_confirmed:ord_1:web:2",
      message,
      channel: message.channels[1],
      source: {
        sourceEventId: "evt_1",
        sourceGlobalPosition: "12",
        projectionName: "ordering-order-notification-projection",
        occurredAt: "2026-05-09T00:00:00.000Z",
      },
      status: "sending",
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
      nextAttemptAt: "2026-05-09T00:00:00.000Z",
      lastError: null,
    };
    const outbox = createMemoryOutbox([delivery]);
    const adapter = {
      channel: "web" as const,
      sendNotificationChannel: vi.fn(async () => ({
        channel: "web" as const,
        providerName: "web-notification-feed" as const,
        providerMessageId: "web_1",
        acceptedAt: "2026-05-09T00:00:01.000Z",
        attemptCount: 1,
      })),
    };
    const dispatcher = createNotificationOutboxDispatcher({
      outbox,
      adapters: [adapter],
      claimOwnerId: "worker_1",
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    const result = await dispatcher.runOnce();

    expect(result.processed).toBe(1);
    expect(adapter.sendNotificationChannel).toHaveBeenCalledWith(delivery);
    expect(outbox.sent).toEqual([delivery.deliveryId]);
  });
});

function createMemoryOutbox(
  claimed: readonly ClaimedNotificationDelivery[],
): NotificationOutboxStore & Readonly<{
  sent: readonly string[];
}> {
  const sent: string[] = [];

  return {
    sent,
    async enqueueNotification() {
      return undefined;
    },
    async claimPendingNotificationDeliveries() {
      return claimed;
    },
    async markNotificationDeliverySent(input) {
      sent.push(input.deliveryId);
    },
    async markNotificationDeliveryFailed() {
      return undefined;
    },
  };
}
