import { t } from "@chase-sets/localization";
import type { WebNotificationFeed } from "@chase-sets/web-notifications";
import { Hono } from "hono";
import type { OrderingApiEnv } from "../../../api";

function requireNotificationAccess(c: {
  get(key: "actor"): OrderingApiEnv["Variables"]["actor"];
}) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({
        error: {
          code: "authentication_required",
          message: t("ordering.features.orders.api.notificationRoutes.authentication.required"),
        },
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes("accounts.view")) {
    return {
      actor: null,
      response: new Response(JSON.stringify({
        error: {
          code: "authorization_forbidden",
          message: t("ordering.features.orders.api.notificationRoutes.forbidden"),
        },
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

export function createAccountOrderNotificationRoutes(
  notifications: WebNotificationFeed,
) {
  const app = new Hono<OrderingApiEnv>();

  app.get("/order-notifications", async (c) => {
    const access = requireNotificationAccess(c);
    if (access.response) return access.response;

    const limit = Number(c.req.query("limit") ?? 25);
    const offset = Number(c.req.query("offset") ?? 0);
    const includeRead = c.req.query("includeRead") !== "false";
    const items = await notifications.listWebNotifications({
      accountId: access.actor.accountId,
      includeRead,
      limit,
      offset,
    });

    return c.json({
      items,
      count: items.length,
      unread: await notifications.countUnreadWebNotifications({
        accountId: access.actor.accountId,
      }),
    });
  });

  app.get("/order-notifications/unread-count", async (c) => {
    const access = requireNotificationAccess(c);
    if (access.response) return access.response;

    return c.json({
      unread: await notifications.countUnreadWebNotifications({
        accountId: access.actor.accountId,
      }),
    });
  });

  app.post("/order-notifications/:deliveryId/read", async (c) => {
    const access = requireNotificationAccess(c);
    if (access.response) return access.response;

    await notifications.markWebNotificationRead({
      accountId: access.actor.accountId,
      deliveryId: c.req.param("deliveryId"),
    });

    return c.json({ status: "read" });
  });

  app.post("/order-notifications/read-all", async (c) => {
    const access = requireNotificationAccess(c);
    if (access.response) return access.response;

    await notifications.markAllWebNotificationsRead({
      accountId: access.actor.accountId,
    });

    return c.json({ status: "read" });
  });

  return app;
}
