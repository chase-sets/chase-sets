import { describe, expect, it } from "vitest";
import {
  applyNotificationChannelPreferences,
  createNotificationChannelAdapterRegistry,
  createNoopNotificationOutbox,
  createNotificationDeliveryId,
  type NotificationChannelAdapter,
  type NotificationMessage,
} from ".";

describe("notifications contract", () => {
  it("supports email, sms, rcs, web, and push notification channels", () => {
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
          channel: "sms",
          to: { e164: "+15551234567", displayName: "Buyer" },
          body: "Order ord_123 is confirmed.",
        },
        {
          channel: "rcs",
          to: { e164: "+15551234567" },
          title: "Order confirmed",
          body: "Order ord_123 is confirmed.",
          actionHref: "/account/purchases/ord_123",
          smsFallback: {
            to: { e164: "+15551234567" },
            body: "Order ord_123 is confirmed.",
          },
        },
        {
          channel: "web",
          recipient: { accountId: "acc_buyer" as never },
          actionHref: "/account/purchases/ord_123",
        },
        {
          channel: "push",
          recipient: { accountId: "acc_buyer" as never },
          title: "Order confirmed",
          body: "Order ord_123 is confirmed.",
          actionHref: "/account/purchases/ord_123",
          collapseKey: "order:ord_123",
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
      "sms",
      "rcs",
      "web",
      "push",
    ]);
  });

  it("supports custom future channels through the same adapter contract", async () => {
    const adapter = {
      channel: "secure-inbox",
      providerName: "internal-secure-inbox",
      async sendNotificationChannel() {
        return {
          channel: "secure-inbox",
          providerName: "internal-secure-inbox",
          providerMessageId: "secure_1",
          acceptedAt: "2026-05-15T00:00:00.000Z",
          attemptCount: 1,
        };
      },
    } satisfies NotificationChannelAdapter;
    const registry = createNotificationChannelAdapterRegistry([adapter]);
    const configuredAdapter = registry.adapterForChannel("secure-inbox");

    expect(registry.configuredChannels).toEqual(["secure-inbox"]);
    if (!configuredAdapter) {
      throw new Error("Expected secure-inbox adapter to be configured.");
    }
    await expect(configuredAdapter.sendNotificationChannel({
      deliveryId: "delivery_1",
      message: {
        messageType: "identity.security.notice",
        criticality: "security",
        title: "Security notice",
        body: "Review your account.",
        templateId: "security_notice",
        templateVersion: 1,
        locale: "en",
        templateData: {},
        channels: [
          {
            channel: "secure-inbox",
            payload: { severity: "high" },
          },
        ],
        idempotencyKey: "identity:security_notice:1",
        correlationId: "req_1",
        actor: { userId: null, accountId: null },
      },
      channel: {
        channel: "secure-inbox",
        payload: { severity: "high" },
      },
    })).resolves.toMatchObject({
      channel: "secure-inbox",
      providerName: "internal-secure-inbox",
    });
  });

  it("rejects duplicate adapters for the same channel", () => {
    expect(() =>
      createNotificationChannelAdapterRegistry([
        {
          channel: "sms",
          async sendNotificationChannel() {
            throw new Error("unused");
          },
        },
        {
          channel: "sms",
          async sendNotificationChannel() {
            throw new Error("unused");
          },
        },
      ]),
    ).toThrow("Multiple notification adapters configured for 'sms'.");
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
