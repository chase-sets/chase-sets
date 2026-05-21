import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { NotificationPreferenceKey, NotificationsServices } from "./features/notification-center/api/services";

export type NotificationsApiEnv = AuthenticatedApiEnv;

const preferenceKeys = new Set<NotificationPreferenceKey>(["web", "email", "sms", "rcs", "product-alerts"]);

function requireAccountAccess(c: { get(key: "actor"): NotificationsApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("notifications.api.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes("accounts.view")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("notifications.api.forbidden"),
          },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function parsePreferenceKey(value: string): NotificationPreferenceKey | null {
  return preferenceKeys.has(value as NotificationPreferenceKey) ? (value as NotificationPreferenceKey) : null;
}

export function buildNotificationsApi(services: NotificationsServices) {
  const app = new Hono<NotificationsApiEnv>();

  app.get("/center", async (c) => {
    const access = requireAccountAccess(c);
    if (access.response) return access.response;

    const limit = Number(c.req.query("limit") ?? 25);
    const offset = Number(c.req.query("offset") ?? 0);
    const includeRead = c.req.query("includeRead") !== "false";
    const items = await services.feed.listWebNotifications({
      accountId: access.actor.accountId,
      includeRead,
      limit,
      offset,
    });

    return c.json({
      items,
      count: items.length,
      unread: await services.feed.countUnreadWebNotifications({
        accountId: access.actor.accountId,
      }),
    });
  });

  app.get("/center/unread-count", async (c) => {
    const access = requireAccountAccess(c);
    if (access.response) return access.response;

    return c.json({
      unread: await services.feed.countUnreadWebNotifications({
        accountId: access.actor.accountId,
      }),
    });
  });

  app.post("/center/:deliveryId/read", async (c) => {
    const access = requireAccountAccess(c);
    if (access.response) return access.response;

    await services.feed.markWebNotificationRead({
      accountId: access.actor.accountId,
      deliveryId: c.req.param("deliveryId"),
    });

    return c.json({ status: "read" });
  });

  app.post("/center/read-all", async (c) => {
    const access = requireAccountAccess(c);
    if (access.response) return access.response;

    await services.feed.markAllWebNotificationsRead({
      accountId: access.actor.accountId,
    });

    return c.json({ status: "read" });
  });

  app.get("/preferences", async (c) => {
    const access = requireAccountAccess(c);
    if (access.response) return access.response;

    return c.json({
      items: await services.preferences.listPreferences(access.actor.accountId),
    });
  });

  app.post("/preferences/:key", async (c) => {
    const access = requireAccountAccess(c);
    if (access.response) return access.response;

    const key = parsePreferenceKey(c.req.param("key"));
    if (!key) {
      return c.json(
        {
          error: {
            code: "invalid_preference",
            message: t("notifications.api.preference.invalid"),
          },
        },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const preference = await services.preferences.setPreference({
      accountId: access.actor.accountId,
      key,
      enabled: Boolean((body as { enabled?: unknown }).enabled),
    });

    return c.json({ item: preference });
  });

  return app;
}

export function buildNotificationsMobileMessageWebhookApi(services: NotificationsServices) {
  const app = new Hono();

  app.post("/mobile-messaging/webhooks", async (c) => {
    try {
      const rawBody = await c.req.raw.text();
      const event = await services.mobileMessageWebhookGateway.processMobileMessageWebhook({
        rawBody,
        url: c.req.url,
        contentType: c.req.header("Content-Type") ?? null,
        signatureHeader: c.req.header("X-Twilio-Signature") ?? null,
      });

      if (!event) {
        return c.json({ status: "ignored" });
      }

      const result = await services.mobileMessages.recordProviderEvent(event);

      return c.json({
        status: result.recorded ? "recorded" : "duplicate",
        event_kind: event.eventKind,
        provider_message_id: event.providerMessageId,
      });
    } catch (error) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: error instanceof Error ? error.message : t("notifications.api.mobile.webhook.failed"),
          },
        },
        400,
      );
    }
  });

  return app;
}
