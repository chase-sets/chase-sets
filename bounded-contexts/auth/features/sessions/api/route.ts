import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthApiEnv } from "../../../api";
import { toSessionStreamId } from "../domain/auth-flow";
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
    const result = await services.commandHandler({
      streamId: toSessionStreamId(sessionId),
      command: {
        type: "SwitchSessionAccount",
        accountId: body.accountId,
      },
      context: c.get("context"),
    });
    return c.json({ id: sessionId, version: result.version, status: result.state.status });
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
    const result = await services.commandHandler({
      streamId: toSessionStreamId(sessionId),
      command: { type: "RevokeSession" },
      context: c.get("context"),
    });
    return c.json({ id: sessionId, version: result.version, status: result.state.status });
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
