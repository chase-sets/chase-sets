import { describe, expect, it } from "vitest";
import {
  applyNotificationChannelPreferences,
  createNotificationChannelAdapterRegistry,
  createNoopTransactionalEmailGateway,
  createTransactionalEmailNotificationMessage,
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
      category: "operational",
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
      "notification-delivery:v1:ordering%3Aorder_confirmed%3Aord_123:email:1",
    );
    expect(createNotificationDeliveryId(message, message.channels[1], 1)).toBe(
      "notification-delivery:v1:ordering%3Aorder_confirmed%3Aord_123:sms:2",
    );
    expect(message.channels.map((channel) => channel.channel)).toEqual(["email", "sms", "rcs", "web", "push"]);
  });

  it("keeps non-primary delivery ids distinct when idempotency keys contain separators", () => {
    const smsChannel = {
      channel: "sms",
      to: { e164: "+15551234567" },
    } satisfies NotificationMessage["channels"][number];
    const customChannel = {
      channel: "email:sms",
      payload: {},
    } satisfies NotificationMessage["channels"][number];

    const firstDeliveryId = createNotificationDeliveryId(
      { idempotencyKey: "ordering:email", channels: [smsChannel, customChannel] },
      smsChannel,
      1,
    );
    const secondDeliveryId = createNotificationDeliveryId(
      { idempotencyKey: "ordering", channels: [smsChannel, customChannel] },
      customChannel,
      1,
    );

    expect(firstDeliveryId).toBe("notification-delivery:v1:ordering%3Aemail:sms:2");
    expect(secondDeliveryId).toBe("notification-delivery:v1:ordering:email%3Asms:2");
    expect(firstDeliveryId).not.toBe(secondDeliveryId);
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
    await expect(
      configuredAdapter.sendNotificationChannel({
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
      }),
    ).resolves.toMatchObject({
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

    await expect(
      outbox.claimPendingNotificationDeliveries({
        limit: 10,
        claimOwnerId: "test",
        claimTtlMs: 1_000,
      }),
    ).resolves.toEqual([]);
  });

  it("represents transactional email as a single email delivery while preserving its idempotency key", () => {
    const message = createTransactionalEmailNotificationMessage({
      messageType: "settlement.payout.completed",
      criticality: "commerce",
      to: [{ email: "seller@example.com" }],
      subject: "Payout po_123 completed",
      templateId: "payout_completed",
      templateVersion: 1,
      locale: "en",
      templateData: { payoutId: "po_123" },
      idempotencyKey: "settlement:payout_completed:po_123",
      correlationId: "evt_123",
      actor: { userId: null, accountId: null },
    });

    expect(message.channels).toHaveLength(1);
    expect(message.channels[0]).toMatchObject({
      channel: "email",
      subject: "Payout po_123 completed",
      templateId: "payout_completed",
    });
    expect(createNotificationDeliveryId(message, message.channels[0], 0)).toBe("settlement:payout_completed:po_123");
  });

  it("keeps a no-op transactional email gateway for provider adapter composition tests", async () => {
    const gateway = createNoopTransactionalEmailGateway();

    await expect(
      gateway.sendTransactionalEmail({
        messageType: "auth.magic-link.requested",
        criticality: "security",
        to: [{ email: "buyer@example.com" }],
        subject: "Your Chase Sets sign-in link",
        templateId: "auth_magic_link",
        templateVersion: 1,
        locale: "en",
        templateData: {},
        idempotencyKey: "auth:magic-link:cmd_1",
        correlationId: "req_123",
        actor: { userId: null, accountId: null },
      }),
    ).resolves.toMatchObject({
      providerName: "amazon-ses",
      providerMessageId: "noop:auth:magic-link:cmd_1",
    });
  });

  it("applies channel preferences while keeping security notifications mandatory", () => {
    const commerceMessage: NotificationMessage = {
      messageType: "ordering.order.created",
      criticality: "commerce",
      category: "operational",
      title: "Order confirmed",
      body: "Order ord_123 is confirmed.",
      templateId: "order_confirmed",
      templateVersion: 1,
      locale: "en",
      templateData: { orderId: "ord_123" },
      channels: [
        { channel: "email", to: [{ email: "buyer@example.com" }] },
        {
          channel: "sms",
          to: { e164: "+15551234567" },
          body: "Order ord_123 is confirmed.",
        },
        {
          channel: "rcs",
          to: { e164: "+15551234567" },
          body: "Order ord_123 is confirmed.",
        },
        { channel: "web", recipient: { accountId: "acc_buyer" as never } },
      ],
      idempotencyKey: "ordering:order_confirmed:ord_123",
      correlationId: "req_123",
      actor: { userId: null, accountId: null },
    };

    expect(
      applyNotificationChannelPreferences(commerceMessage, [{ channel: "email", enabled: false }])?.channels.map(
        (channel) => channel.channel,
      ),
    ).toEqual(["sms", "rcs", "web"]);

    expect(
      applyNotificationChannelPreferences(commerceMessage, [
        { channel: "email", enabled: false },
        { channel: "sms", enabled: false },
        { channel: "rcs", enabled: false },
        { channel: "web", enabled: false },
      ]),
    ).toBeNull();

    expect(
      applyNotificationChannelPreferences({ ...commerceMessage, category: undefined }, [
        { channel: "email", enabled: false },
        { channel: "sms", enabled: false },
        { channel: "rcs", enabled: false },
        { channel: "web", enabled: false },
      ])?.channels.map((channel) => channel.channel),
    ).toEqual(["email", "sms", "rcs", "web"]);

    expect(
      applyNotificationChannelPreferences(
        {
          ...commerceMessage,
          criticality: "security",
          category: "security",
        },
        [
          { channel: "email", enabled: false },
          { channel: "sms", enabled: false },
          { channel: "rcs", enabled: false },
          { channel: "web", enabled: false },
        ],
      )?.channels.map((channel) => channel.channel),
    ).toEqual(["email", "sms", "rcs", "web"]);

    expect(
      applyNotificationChannelPreferences(
        {
          ...commerceMessage,
          category: "product-alerts",
        },
        [{ channel: null, category: "product-alerts", enabled: false }],
      ),
    ).toBeNull();
  });
});
