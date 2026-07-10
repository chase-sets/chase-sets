import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { IdentityApiEnv } from "../../../api";
import type { UserServices } from "./runtime";
import { PLATFORM_ADMIN_ROLE_KEY, type AuthMethodKey } from "../../../support/runtime-support/common";

function canManageUser(actor: IdentityApiEnv["Variables"]["actor"], userId: string) {
  return !actor || actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.userId === userId;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.users.api.route.forbidden"),
    },
  };
}

function badRequest(message: string) {
  return {
    error: {
      code: "validation_error",
      message,
    },
  };
}

function isAuthMethodKey(value: string): value is AuthMethodKey {
  return (
    value === "password" ||
    value === "magic-link" ||
    value === "passkey" ||
    value === "sms-code" ||
    value === "social-login"
  );
}

export function userRoutes(services: UserServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const userId = parseTypedIdBoundary(body.userId, "usr", "userId");
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "CreateUser",
        userId,
        displayName: body.displayName,
        givenName: body.givenName,
        familyName: body.familyName,
        primaryEmail: body.primaryEmail,
      },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    if (!canManageUser(c.var.actor, userId)) {
      return c.json(forbidden(), 403);
    }
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "UpdateUserProfile",
        displayName: body.displayName,
        givenName: body.givenName,
        familyName: body.familyName,
      },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/contact-methods", async (c) => {
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    if (!canManageUser(c.var.actor, userId)) {
      return c.json(forbidden(), 403);
    }
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "AddContactMethod",
        contactMethodId: parseTypedIdBoundary(body.contactMethodId, "ctm", "contactMethodId"),
        contactMethodType: body.contactMethodType,
        value: body.value,
      },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/contact-methods/:contactMethodId/verify", async (c) => {
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    const contactMethodId = parseTypedIdBoundary(c.req.param("contactMethodId"), "ctm", "contactMethodId");
    if (!canManageUser(c.var.actor, userId)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "VerifyContactMethod",
        contactMethodId,
        verifiedAt: new Date().toISOString(),
      },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/auth-methods", async (c) => {
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    if (!canManageUser(c.var.actor, userId)) {
      return c.json(forbidden(), 403);
    }
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "EnableAuthMethod", authMethod: body.authMethod },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.delete("/:id/auth-methods/:authMethod", async (c) => {
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    if (!canManageUser(c.var.actor, userId)) {
      return c.json(forbidden(), 403);
    }
    const authMethod = c.req.param("authMethod");
    if (!isAuthMethodKey(authMethod)) {
      return c.json(badRequest(t("identity.features.users.api.route.auth.method.invalid")), 400);
    }
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "DisableAuthMethod", authMethod },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/suspend", async (c) => {
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    if (!canManageUser(c.var.actor, userId)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "SuspendUser" },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/reactivate", async (c) => {
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    if (!canManageUser(c.var.actor, userId)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "ReactivateUser" },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset } = c.req.query();
    if (actor && actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY) {
      const user = await services.getUser(actor.userId);
      const items = user ? [user] : [];
      return c.json({ items, total: items.length, count: items.length });
    }

    const result = await services.listUsers({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const actor = c.var.actor;
    const userId = parseTypedIdBoundary(c.req.param("id"), "usr", "userId");
    if (actor && !canManageUser(actor, userId)) {
      return c.json(forbidden(), 403);
    }

    const user = await services.getUser(userId);
    if (!user) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.users.api.route.user.not.found") } },
        404,
      );
    }
    return c.json(user);
  });

  return app;
}
