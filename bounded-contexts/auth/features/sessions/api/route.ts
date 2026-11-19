import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthApiEnv } from "../../../api";
import { toSessionStreamId } from "../domain/auth-flow";
import { SessionRefusalError, type SessionRefusalCode } from "../domain/domain";
import type { SessionServices } from "./runtime";

function canManageSession(
  actor: AuthApiEnv["Variables"]["actor"],
  session: Readonly<{ session_id: string; user_id: string }>,
) {
  return (
    !actor ||
    actor.roleKey === "platform-admin" ||
    actor.sessionId === session.session_id ||
    actor.userId === session.user_id
  );
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("auth.features.sessions.api.route.forbidden"),
    },
  };
}

function sessionRefusal(code: SessionRefusalCode) {
  switch (code) {
    case "not-active":
      return {
        status: 409,
        code: "session_not_active",
        message: t("auth.features.sessions.api.route.refused.notActive"),
      } as const;
    case "account-required":
      return {
        status: 400,
        code: "validation_failed",
        message: t("auth.features.sessions.api.route.refused.accountRequired"),
      } as const;
    case "account-unavailable":
      return {
        status: 400,
        code: "session_account_unavailable",
        message: t("auth.features.sessions.api.route.refused.accountUnavailable"),
      } as const;
    case "account-current":
      return {
        status: 409,
        code: "session_account_current",
        message: t("auth.features.sessions.api.route.refused.accountCurrent"),
      } as const;
  }
}

export function sessionRoutes(services: SessionServices) {
  const app = new Hono<AuthApiEnv>();

  app.post("/:id/switch-account", async (c) => {
    const sessionId = c.req.param("id");
    const session = await services.getSession(sessionId);
    if (!session) {
      return c.json(
        { error: { code: "not_found", message: t("auth.features.sessions.api.route.session.not.found") } },
        404,
      );
    }
    if (!canManageSession(c.var.actor, session)) {
      return c.json(forbidden(), 403);
    }
    const body = await c.req.json();
    try {
      const result = await services.commandHandler({
        streamId: toSessionStreamId(sessionId),
        command: {
          type: "SwitchSessionAccount",
          accountId: body.accountId,
        },
        context: c.get("context"),
      });
      return c.json({ id: sessionId, version: result.version, status: result.state.status });
    } catch (error) {
      if (!(error instanceof SessionRefusalError)) throw error;
      const refusal = sessionRefusal(error.code);
      return c.json({ error: { code: refusal.code, message: refusal.message } }, refusal.status);
    }
  });

  app.post("/:id/revoke", async (c) => {
    const sessionId = c.req.param("id");
    const session = await services.getSession(sessionId);
    if (!session) {
      return c.json(
        { error: { code: "not_found", message: t("auth.features.sessions.api.route.session.not.found") } },
        404,
      );
    }
    if (!canManageSession(c.var.actor, session)) {
      return c.json(forbidden(), 403);
    }
    try {
      const result = await services.commandHandler({
        streamId: toSessionStreamId(sessionId),
        command: { type: "RevokeSession" },
        context: c.get("context"),
      });
      return c.json({ id: sessionId, version: result.version, status: result.state.status });
    } catch (error) {
      if (!(error instanceof SessionRefusalError)) throw error;
      const refusal = sessionRefusal(error.code);
      return c.json({ error: { code: refusal.code, message: refusal.message } }, refusal.status);
    }
  });

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listSessions({
      search: actor && actor.roleKey !== "platform-admin" ? actor.userId : search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const session = await services.getSession(c.req.param("id"));
    if (!session) {
      return c.json(
        { error: { code: "not_found", message: t("auth.features.sessions.api.route.session.not.found") } },
        404,
      );
    }
    if (!canManageSession(c.var.actor, session)) {
      return c.json(forbidden(), 403);
    }
    return c.json(session);
  });

  return app;
}
