import { Hono } from "hono";
import type { AuthApiEnv } from "../api";
import { toSessionStreamId } from "./auth-flow";
import type { SessionServices } from "./runtime";

export function sessionRoutes(services: SessionServices) {
  const app = new Hono<AuthApiEnv>();

  app.post("/:id/switch-account", async (c) => {
    const sessionId = c.req.param("id");
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
    const result = await services.commandHandler({
      streamId: toSessionStreamId(sessionId),
      command: { type: "RevokeSession" },
      context: c.get("context"),
    });
    return c.json({ id: sessionId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listSessions({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const session = await services.getSession(c.req.param("id"));
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    return c.json(session);
  });

  return app;
}
