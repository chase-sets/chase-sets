import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { WebNotificationFeed } from "@chase-sets/web-notifications";
import type { OrderingApiEnv } from "../../../api";
import { createAccountOrderNotificationRoutes } from "./notification-routes";

function buildApp(notifications: WebNotificationFeed) {
  const app = new Hono<OrderingApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_1",
      tenantId: "tnt_identity",
      userId: "usr_buyer",
      accountId: "acc_buyer",
      membershipId: "mbr_1",
      roleKey: "owner",
      permissions: ["accounts.view"],
    });
    await next();
  });
  app.route("/account", createAccountOrderNotificationRoutes(notifications));

  return app;
}

function createFeed(): WebNotificationFeed {
  return {
    listWebNotifications: vi.fn(async () => [{
      notificationId: "1",
      deliveryId: "del_order_1",
      userId: null,
      accountId: "acc_buyer",
      messageType: "ordering.order.created",
      criticality: "commerce",
      title: "Order confirmed",
      body: "Order ord_1 is confirmed.",
      actionHref: "/account/purchases/ord_1",
      correlationId: "req_1",
      sourceIdempotencyKey: "ordering:order_confirmed:ord_1",
      readAt: null,
      createdAt: "2026-05-09T00:00:00.000Z",
    }]),
    countUnreadWebNotifications: vi.fn(async () => 1),
    markWebNotificationRead: vi.fn(async () => undefined),
    markAllWebNotificationsRead: vi.fn(async () => undefined),
  };
}

describe("ordering notification routes", () => {
  it("lists and marks account order notifications", async () => {
    const feed = createFeed();
    const app = buildApp(feed);

    const listResponse = await app.fetch(
      new Request("http://ordering.test/account/order-notifications?includeRead=false"),
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      count: 1,
      unread: 1,
      items: [{ deliveryId: "del_order_1" }],
    });
    expect(feed.listWebNotifications).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "acc_buyer",
      includeRead: false,
    }));

    const readResponse = await app.fetch(
      new Request("http://ordering.test/account/order-notifications/del_order_1/read", {
        method: "POST",
      }),
    );
    expect(readResponse.status).toBe(200);
    expect(feed.markWebNotificationRead).toHaveBeenCalledWith({
      accountId: "acc_buyer",
      deliveryId: "del_order_1",
    });
  });
});
