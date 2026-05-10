import { describe, expect, it } from "vitest";
import {
  applyNotificationChannelPreferences,
  createNoopNotificationOutbox,
  createNotificationDeliveryId,
  type NotificationMessage,
} from ".";

describe("notifications contract", () => {
  it("supports email and web notification channels", () => {
    const message: NotificationMessage = {
      messageType: "ordering.order.created",
      criticality: "commerce",
      title: "Order confirmed",
      body: "Order ord_123 is confirmed.",
      actionHref: "/account/purchases/ord_123",
      templateId: "order_confirmed",
      templateVersion: 1,
      locale: "en",
      templateData: { orderId: "ord_123" },
      channels: [
        { channel: "email", to: [{ email: "buyer@example.com" }] },
        {
          channel: "web",
          recipient: { accountId: "acc_buyer" as never },
          actionHref: "/account/purchases/ord_123",
        },
      ],
      idempotencyKey: "ordering:order_confirmed:ord_123",
      correlationId: "req_123",
      actor: { userId: null, accountId: null },
    };

    expect(createNotificationDeliveryId(message, message.channels[0], 0)).toBe(
      "ordering:order_confirmed:ord_123:email:1",
    );
    expect(message.channels.map((channel) => channel.channel)).toEqual([
      "email",
      "web",
    ]);
  });

  it("supports a no-op outbox for unconfigured composition roots", async () => {
    const outbox = createNoopNotificationOutbox();

    await expect(outbox.claimPendingNotificationDeliveries({
      limit: 10,
      claimOwnerId: "test",
      claimTtlMs: 1_000,
    })).resolves.toEqual([]);
  });

  it("applies channel preferences while keeping security notifications mandatory", () => {
    const commerceMessage: NotificationMessage = {
      messageType: "ordering.order.created",
      criticality: "commerce",
      title: "Order confirmed",
      body: "Order ord_123 is confirmed.",
      templateId: "order_confirmed",
      templateVersion: 1,
      locale: "en",
      templateData: { orderId: "ord_123" },
      channels: [
        { channel: "email", to: [{ email: "buyer@example.com" }] },
        { channel: "web", recipient: { accountId: "acc_buyer" as never } },
      ],
      idempotencyKey: "ordering:order_confirmed:ord_123",
      correlationId: "req_123",
      actor: { userId: null, accountId: null },
    };

    expect(applyNotificationChannelPreferences(commerceMessage, [
      { channel: "email", enabled: false },
    ])?.channels.map((channel) => channel.channel)).toEqual(["web"]);

    expect(applyNotificationChannelPreferences(commerceMessage, [
      { channel: "email", enabled: false },
      { channel: "web", enabled: false },
    ])).toBeNull();

    expect(applyNotificationChannelPreferences({
      ...commerceMessage,
      criticality: "security",
    }, [
      { channel: "email", enabled: false },
      { channel: "web", enabled: false },
    ])?.channels.map((channel) => channel.channel)).toEqual(["email", "web"]);
  });
});
