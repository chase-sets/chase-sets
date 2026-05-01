import { Hono } from "hono";
import type { IdentityApiEnv } from "../../../api";
import type { ApiKeyServices } from "./runtime";

export function apiKeyRoutes(services: ApiKeyServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/:id/revoke", async (c) => {
    const apiKeyId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: { type: "RevokeApiKey" },
      context: c.get("context"),
    });
    return c.json({ id: apiKeyId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listApiKeys({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const apiKey = await services.getApiKey(c.req.param("id"));
    if (!apiKey) {
      return c.json({ error: { code: "not_found", message: "API key not found." } }, 404);
    }
    return c.json(apiKey);
  });

  return app;
}
