import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotificationsApi,
  buildNotificationsMobileMessageWebhookApi,
  type NotificationsApiEnv,
} from "../../../api";
import type { NotificationsServices } from "./services";

function buildApp(services: NotificationsServices) {
  const app = new Hono<NotificationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_1" as never,
      tenantId: "tnt_1" as never,
      userId: "usr_1" as never,
      accountId: "acc_1" as never,
      membershipId: "mem_1" as never,
      roleKey: "member",
      permissions: ["accounts.view"],
    });
    await next();
  });
  app.route("/api/notifications", buildNotificationsApi(services));
  return app;
}

describe("notifications api", () => {
  it("lists centralized feed items and marks them read", async () => {
    const services = {
      feed: {
        listWebNotifications: vi.fn(async () => [
          {
            notificationId: "1",
            deliveryId: "del_1",
            userId: null,
            accountId: "acc_1",
            messageType: "ordering.order.created",
            criticality: "commerce",
            title: "Order confirmed",
            body: "Your order is ready.",
            actionHref: "/account/purchases/ord_1",
            correlationId: "ord_1",
            sourceIdempotencyKey: "order:ord_1",
            readAt: null,
            createdAt: "2026-05-13T00:00:00.000Z",
          },
        ]),
        countUnreadWebNotifications: vi.fn(async () => 1),
        markWebNotificationRead: vi.fn(async () => undefined),
        markAllWebNotificationsRead: vi.fn(async () => undefined),
      },
      mobileMessages: {
        recordProviderEvent: vi.fn(),
      },
      mobileMessageWebhookGateway: {
        processMobileMessageWebhook: vi.fn(),
      },
      notificationOutbox: {},
      preferences: {
        listPreferences: vi.fn(async () => []),
        setPreference: vi.fn(),
      },
    } as unknown as NotificationsServices;
    const app = buildApp(services);

    const feed = await app.request("/api/notifications/center?includeRead=true");
    expect(feed.status).toBe(200);
    expect(await feed.json()).toMatchObject({
      count: 1,
      unread: 1,
      items: [{ deliveryId: "del_1", title: "Order confirmed" }],
    });

    const read = await app.request("/api/notifications/center/del_1/read", {
      method: "POST",
    });
    expect(read.status).toBe(200);
    expect(services.feed.markWebNotificationRead).toHaveBeenCalledWith({
      accountId: "acc_1",
      deliveryId: "del_1",
    });
  });

  it("persists notification preferences by account", async () => {
    const services = {
      feed: {
        listWebNotifications: vi.fn(),
        countUnreadWebNotifications: vi.fn(),
        markWebNotificationRead: vi.fn(),
        markAllWebNotificationsRead: vi.fn(),
      },
      mobileMessages: {
        recordProviderEvent: vi.fn(),
      },
      mobileMessageWebhookGateway: {
        processMobileMessageWebhook: vi.fn(),
      },
      notificationOutbox: {},
      preferences: {
        listPreferences: vi.fn(async () => [{ key: "product-alerts", enabled: true }]),
        setPreference: vi.fn(async (input) => ({
          key: input.key,
          enabled: input.enabled,
        })),
      },
    } as unknown as NotificationsServices;
    const app = buildApp(services);

    const preferences = await app.request("/api/notifications/preferences");
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toEqual({
      items: [{ key: "product-alerts", enabled: true }],
    });

    const saved = await app.request("/api/notifications/preferences/product-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(saved.status).toBe(200);
    expect(services.preferences.setPreference).toHaveBeenCalledWith({
      accountId: "acc_1",
      key: "product-alerts",
      enabled: false,
    });
  });

  it("records provider SMS/RCS webhooks without marketplace auth", async () => {
    const event = {
      providerEventId: "twilio:SM123:delivery-status:delivered",
      providerName: "twilio" as const,
      eventKind: "delivery-status" as const,
      providerMessageId: "SM123",
      deliveryId: "delivery_1",
      status: "delivered",
      occurredAt: "2026-05-15T12:00:00.000Z",
    };
    const services = {
      feed: {
        listWebNotifications: vi.fn(),
        countUnreadWebNotifications: vi.fn(),
        markWebNotificationRead: vi.fn(),
        markAllWebNotificationsRead: vi.fn(),
      },
      mobileMessages: {
        recordProviderEvent: vi.fn(async () => ({ recorded: true })),
      },
      mobileMessageWebhookGateway: {
        processMobileMessageWebhook: vi.fn(async () => event),
      },
      notificationOutbox: {},
      preferences: {
        listPreferences: vi.fn(async () => []),
        setPreference: vi.fn(),
      },
    } as unknown as NotificationsServices;
    const app = new Hono();
    app.route("/api/notifications/provider", buildNotificationsMobileMessageWebhookApi(services));

    const response = await app.request(
      "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks?deliveryId=delivery_1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": "sig_test",
        },
        body: "MessageSid=SM123&MessageStatus=delivered",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "recorded",
      event_kind: "delivery-status",
      provider_message_id: "SM123",
    });
    expect(services.mobileMessageWebhookGateway.processMobileMessageWebhook).toHaveBeenCalledWith({
      rawBody: "MessageSid=SM123&MessageStatus=delivered",
      url: "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks?deliveryId=delivery_1",
      contentType: "application/x-www-form-urlencoded",
      signatureHeader: "sig_test",
    });
    expect(services.mobileMessages.recordProviderEvent).toHaveBeenCalledWith(event);
  });
});
