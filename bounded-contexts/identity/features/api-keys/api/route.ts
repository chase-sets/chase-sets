import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { IdentityApiEnv } from "../../../api";
import type { ApiKeyServices } from "./runtime";

function canManageApiKey(actor: IdentityApiEnv["Variables"]["actor"], apiKey: Readonly<{ user_id: string }>) {
  return !actor || actor.roleKey === "platform-admin" || actor.userId === apiKey.user_id;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.apiKeys.api.route.forbidden"),
    },
  };
}

export function apiKeyRoutes(services: ApiKeyServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/:id/revoke", async (c) => {
    const apiKeyId = c.req.param("id");
    const apiKey = await services.getApiKey(apiKeyId);
    if (!apiKey) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.apiKeys.api.route.api.key.not.found") } },
        404,
      );
    }
    if (!canManageApiKey(c.var.actor, apiKey)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: { type: "RevokeApiKey" },
      context: c.get("context"),
    });
    return c.json({ id: apiKeyId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listApiKeys({
      search: actor && actor.roleKey !== "platform-admin" ? actor.userId : search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const apiKey = await services.getApiKey(c.req.param("id"));
    if (!apiKey) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.apiKeys.api.route.api.key.not.found") } },
        404,
      );
    }
    if (!canManageApiKey(c.var.actor, apiKey)) {
      return c.json(forbidden(), 403);
    }
    return c.json(apiKey);
  });

  return app;
}
