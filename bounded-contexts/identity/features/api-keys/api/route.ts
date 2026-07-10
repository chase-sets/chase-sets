import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { createId } from "@chase-sets/primitives/typed-ids";
import { Hono } from "hono";
import type { IdentityApiEnv } from "../../../api";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import type { IdentitySecretAdapters } from "./secret-adapters";
import { deleteApiKeySecret, upsertApiKeySecret } from "./secret-store";
import type { ApiKeyServices } from "./runtime";

function canManageApiKey(actor: IdentityApiEnv["Variables"]["actor"], apiKey: Readonly<{ user_id: string }>) {
  return !actor || actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.userId === apiKey.user_id;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.apiKeys.api.route.forbidden"),
    },
  };
}

export type ApiKeyRouteServices = ApiKeyServices &
  Readonly<{
    db: PgQueryable;
    auth: IdentitySecretAdapters;
    getUser: (userId: string) => Promise<unknown | null>;
  }>;

function badRequest(message: string) {
  return {
    error: {
      code: "validation_error",
      message,
    },
  };
}

export function apiKeyRoutes(services: ApiKeyRouteServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const actor = c.var.actor;
    const userId = parseTypedIdBoundary(body.userId, "usr", "userId");
    if (actor && actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY && actor.userId !== userId) {
      return c.json(forbidden(), 403);
    }
    const user = await services.getUser(userId);
    if (!user) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.apiKeys.api.route.user.not.found") } },
        404,
      );
    }

    const apiKeyId = createId("key");
    const secret = services.auth.issueOpaqueToken("key");
    const keyPrefix = secret.slice(0, 12);
    const result = await services.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: {
        type: "CreateApiKey",
        apiKeyId,
        userId,
        name: body.name,
        keyPrefix,
      },
      context: c.get("context"),
    });
    await upsertApiKeySecret(services.db, {
      apiKeyId,
      userId,
      keyPrefix,
      secretHash: services.auth.hashSecret(secret),
    });

    return c.json(
      {
        id: apiKeyId,
        version: result.version,
        status: result.state.status,
        secret,
        keyPrefix,
      },
      201,
    );
  });

  app.post("/:id/rotate", async (c) => {
    const apiKeyId = parseTypedIdBoundary(c.req.param("id"), "key", "apiKeyId");
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

    const secret = services.auth.issueOpaqueToken("key");
    const keyPrefix = secret.slice(0, 12);
    const result = await services.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: {
        type: "RotateApiKey",
        keyPrefix,
      },
      context: c.get("context"),
    });
    await upsertApiKeySecret(services.db, {
      apiKeyId,
      userId: apiKey.user_id,
      keyPrefix,
      secretHash: services.auth.hashSecret(secret),
    });

    return c.json({
      id: apiKeyId,
      version: result.version,
      status: result.state.status,
      secret,
      keyPrefix,
    });
  });

  app.post("/:id/revoke", async (c) => {
    const apiKeyId = parseTypedIdBoundary(c.req.param("id"), "key", "apiKeyId");
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
    await deleteApiKeySecret(services.db, apiKeyId);
    return c.json({ id: apiKeyId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listApiKeys({
      search: actor && actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY ? actor.userId : search,
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
