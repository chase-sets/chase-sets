import { Hono } from "hono";
import type { Context } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  ApiKeyId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import { getApiKeySecretByPrefix, upsertApiKeySecret } from "./api-keys/secret-store";
import type { PermissionKey } from "./common";
import type { IdentityServices } from "./services";
import {
  hasPermission,
  type ResolvedActor,
} from "./server";
import { accountRoutes } from "./accounts/route";
import { userRoutes } from "./users/route";
import { membershipRoutes } from "./memberships/route";
import { invitationRoutes } from "./invitations/route";
import { apiKeyRoutes } from "./api-keys/route";
import { consentRoutes } from "./consents/route";
import { createIdentityBootstrapContext } from "./bootstrap-context";

export type IdentityApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor | null;
  };
};

export function createBootstrapContext(): EventStoreContext {
  return createIdentityBootstrapContext();
}

function getBootstrapContext(c: Context<IdentityApiEnv>) {
  return c.var.context ?? createBootstrapContext();
}

function getRequiredContext(c: Context<IdentityApiEnv>) {
  const context = c.var.context;
  if (!context) {
    throw new Error("Missing identity request context.");
  }
  return context;
}

async function drainProjectors(services: IdentityServices) {
  let processed = 0;
  do {
    processed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

function requirePermission(
  readPermission: PermissionKey,
  writePermission = readPermission,
) {
  return async (c: Context<IdentityApiEnv>, next: () => Promise<void>) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const requiredPermission =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? readPermission
        : writePermission;

    if (!hasPermission(actor, requiredPermission)) {
      return c.json({ error: "Forbidden." }, 403);
    }

    await next();
  };
}

export function buildIdentityApi(services: IdentityServices) {
  const app = new Hono<IdentityApiEnv>();

  app.use("/accounts", requirePermission("accounts.view", "accounts.manage"));
  app.use("/accounts/*", requirePermission("accounts.view", "accounts.manage"));
  app.use("/users", requirePermission("security.manage"));
  app.use("/users/*", requirePermission("security.manage"));
  app.use("/memberships", requirePermission("memberships.view", "memberships.manage"));
  app.use("/memberships/*", requirePermission("memberships.view", "memberships.manage"));
  app.use("/invitations", requirePermission("memberships.manage"));
  app.use("/invitations/*", requirePermission("memberships.manage"));
  app.use("/api-keys", requirePermission("security.manage"));
  app.use("/api-keys/*", requirePermission("security.manage"));

  app.route("/accounts", accountRoutes(services.accounts));
  app.route("/users", userRoutes(services.users));
  app.route("/memberships", membershipRoutes(services.memberships));
  app.route("/invitations", invitationRoutes(services.invitations));
  app.route("/api-keys", apiKeyRoutes(services.apiKeys));
  app.route("/consents", consentRoutes(services.consents));

  app.post("/api-keys", async (c) => {
    const body = await c.req.json();
    const context = getRequiredContext(c);
    const apiKeyId = createId("key") as ApiKeyId;
    const secret = services.auth.issueOpaqueToken("key");
    const keyPrefix = secret.slice(0, 12);
    const result = await services.apiKeys.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: {
        type: "CreateApiKey",
        apiKeyId,
        userId: body.userId,
        name: body.name,
        keyPrefix,
      },
      context,
    });
    await upsertApiKeySecret(services.db, {
      apiKeyId,
      userId: body.userId,
      keyPrefix,
      secretHash: services.auth.hashSecret(secret),
    });
    await drainProjectors(services);
    return c.json({
      id: apiKeyId,
      version: result.version,
      status: result.state.status,
      secret,
      keyPrefix,
    }, 201);
  });

  app.post("/api-keys/:id/rotate", async (c) => {
    const apiKeyId = c.req.param("id");
    const apiKey = await services.apiKeys.getApiKey(apiKeyId);
    if (!apiKey) {
      return c.json({ error: "API key not found." }, 404);
    }
    const context = getRequiredContext(c);
    const secret = services.auth.issueOpaqueToken("key");
    const keyPrefix = secret.slice(0, 12);
    const result = await services.apiKeys.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: {
        type: "RotateApiKey",
        keyPrefix,
      },
      context,
    });
    await upsertApiKeySecret(services.db, {
      apiKeyId: apiKeyId as ApiKeyId,
      userId: apiKey.user_id,
      keyPrefix,
      secretHash: services.auth.hashSecret(secret),
    });
    await drainProjectors(services);
    return c.json({
      id: apiKeyId,
      version: result.version,
      status: result.state.status,
      secret,
      keyPrefix,
    });
  });

  app.post("/api-keys/resolve", async (c) => {
    const body = await c.req.json();
    const secret = String(body.secret ?? "");
    const keyPrefix = secret.slice(0, 12);
    const apiKeySecret = await getApiKeySecretByPrefix(services.db, keyPrefix);
    if (
      !apiKeySecret ||
      !services.auth.verifySecret(secret, apiKeySecret.secret_hash)
    ) {
      return c.json({ error: "Invalid API key." }, 401);
    }
    await services.apiKeys.commandHandler({
      streamId: `identity.api-key-${apiKeySecret.api_key_id}`,
      command: { type: "RecordApiKeyUse", usedAt: new Date().toISOString() },
      context: getBootstrapContext(c),
    });
    await drainProjectors(services);
    return c.json({
      apiKeyId: apiKeySecret.api_key_id,
      userId: apiKeySecret.user_id as UserId,
      keyPrefix,
    });
  });

  return app;
}
