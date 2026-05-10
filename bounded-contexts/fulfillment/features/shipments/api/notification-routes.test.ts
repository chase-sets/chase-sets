import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { WebNotificationFeed } from "@chase-sets/web-notifications";
import type { FulfillmentApiEnv } from "../../../api";
import { createAccountShipmentNotificationRoutes } from "./notification-routes";

function buildApp(notifications: WebNotificationFeed) {
  const app = new Hono<FulfillmentApiEnv>();

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
  app.route("/account", createAccountShipmentNotificationRoutes(notifications));

  return app;
}

function createFeed(): WebNotificationFeed {
  return {
    listWebNotifications: vi.fn(async () => [{
      notificationId: "1",
      deliveryId: "del_shipment_1",
      userId: null,
      accountId: "acc_buyer",
      messageType: "fulfillment.shipment.delivered",
      criticality: "operational",
      title: "Shipment delivered",
      body: "Shipment shp_1 was delivered.",
      actionHref: "/account/shipments/shp_1",
      correlationId: "req_1",
      sourceIdempotencyKey: "fulfillment:shipment_delivered:ord_1:trk_1",
      readAt: null,
      createdAt: "2026-05-09T00:00:00.000Z",
    }]),
    countUnreadWebNotifications: vi.fn(async () => 1),
    markWebNotificationRead: vi.fn(async () => undefined),
    markAllWebNotificationsRead: vi.fn(async () => undefined),
  };
}

describe("fulfillment notification routes", () => {
  it("lists and marks account shipment notifications", async () => {
    const feed = createFeed();
    const app = buildApp(feed);

    const listResponse = await app.fetch(
      new Request("http://fulfillment.test/account/shipment-notifications"),
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      count: 1,
      unread: 1,
      items: [{ deliveryId: "del_shipment_1" }],
    });

    const readAllResponse = await app.fetch(
      new Request("http://fulfillment.test/account/shipment-notifications/read-all", {
        method: "POST",
      }),
    );
    expect(readAllResponse.status).toBe(200);
    expect(feed.markAllWebNotificationsRead).toHaveBeenCalledWith({
      accountId: "acc_buyer",
    });
  });
});
