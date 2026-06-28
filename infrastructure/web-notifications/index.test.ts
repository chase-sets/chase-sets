import { describe, expect, it, vi } from "vitest";
import type { NotificationMessage } from "@chase-sets/outbound-messaging";
import {
  createPostgresWebNotificationFeed,
  createPostgresWebNotificationAdapter,
  webNotificationsSchemaSql,
} from "./index";

const message: NotificationMessage = {
  messageType: "fulfillment.shipment.delivered",
  criticality: "operational",
  title: "Shipment delivered",
  body: "Your shipment for order ord_1 was delivered.",
  actionHref: "/account/shipments/shp_1",
  templateId: "shipment_delivered",
  templateVersion: 1,
  locale: "en",
  templateData: { orderId: "ord_1", trackingNumber: "9400" },
  channels: [
    {
      channel: "web",
      recipient: { accountId: "acc_buyer" as never },
      actionHref: "/account/shipments/shp_1",
    },
  ],
  idempotencyKey: "fulfillment:shipment_delivered:ord_1:9400",
  correlationId: "req_1",
  actor: { userId: null, accountId: null },
};

describe("web notification adapter", () => {
  it("stores web notifications in an idempotent feed table", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    };
    const adapter = createPostgresWebNotificationAdapter({
      db,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    const receipt = await adapter.sendNotificationChannel({
      deliveryId: "fulfillment:shipment_delivered:ord_1:9400:web:1",
      message,
      channel: message.channels[0],
    });

    expect(receipt).toEqual({
      channel: "web",
      providerName: "web-notification-feed",
      providerMessageId: "fulfillment:shipment_delivered:ord_1:9400:web:1",
      acceptedAt: "2026-05-09T00:00:00.000Z",
      attemptCount: 1,
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (delivery_id) DO NOTHING"),
      expect.arrayContaining(["fulfillment:shipment_delivered:ord_1:9400:web:1", null, "acc_buyer"]),
    );
    expect(webNotificationsSchemaSql).toContain("web_notifications");
  });

  it("lists, counts, and marks feed notifications read", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              notification_id: "1",
              delivery_id: "del_1",
              user_id: null,
              account_id: "acc_buyer",
              message_type: "ordering.order.created",
              criticality: "commerce",
              title: "Order confirmed",
              body: "Order ord_1 is confirmed.",
              action_href: "/account/purchases/ord_1",
              correlation_id: "req_1",
              source_idempotency_key: "ordering:order_confirmed:ord_1",
              read_at: null,
              created_at: new Date("2026-05-09T00:00:00.000Z"),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ unread_count: "3" }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 }),
    };
    const feed = createPostgresWebNotificationFeed({
      db,
      now: () => new Date("2026-05-09T00:00:01.000Z"),
    });

    await expect(
      feed.listWebNotifications({
        accountId: "acc_buyer",
        includeRead: false,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        notificationId: "1",
        deliveryId: "del_1",
        accountId: "acc_buyer",
        readAt: null,
        createdAt: "2026-05-09T00:00:00.000Z",
      }),
    ]);
    await expect(
      feed.countUnreadWebNotifications({
        accountId: "acc_buyer",
      }),
    ).resolves.toBe(3);

    await feed.markWebNotificationRead({
      accountId: "acc_buyer",
      deliveryId: "del_1",
    });
    await feed.markAllWebNotificationsRead({ accountId: "acc_buyer" });

    expect(db.query).toHaveBeenCalledTimes(4);
    expect(db.query.mock.calls[0]?.[0]).toContain("read_at IS NULL");
    expect(db.query.mock.calls[2]?.[1]).toEqual(["2026-05-09T00:00:01.000Z", "acc_buyer", "del_1"]);
  });
});
