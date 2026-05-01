import { Hono } from "hono";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { hasPermission } from "../../../support/request-support/permissions";
import type { UserServices } from "./runtime";

export function userRoutes(services: UserServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const userId = body.userId as UserId;
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
    const userId = c.req.param("id");
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
    const userId = c.req.param("id");
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "AddContactMethod",
        contactMethodId: body.contactMethodId,
        contactMethodType: body.contactMethodType,
        value: body.value,
      },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/contact-methods/:contactMethodId/verify", async (c) => {
    const userId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "VerifyContactMethod",
        contactMethodId: c.req.param("contactMethodId"),
        verifiedAt: new Date().toISOString(),
      },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/auth-methods", async (c) => {
    const userId = c.req.param("id");
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "EnableAuthMethod", authMethod: body.authMethod },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/suspend", async (c) => {
    const userId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "SuspendUser" },
      context: c.get("context"),
    });
    return c.json({ id: userId, version: result.version, status: result.state.status });
  });

  app.post("/:id/reactivate", async (c) => {
    const userId = c.req.param("id");
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
    if (actor && !hasPermission(actor, "security.manage")) {
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
    const userId = c.req.param("id");
    if (actor && !hasPermission(actor, "security.manage") && actor.userId !== userId) {
      return c.json({ error: { code: "authorization_forbidden", message: "Forbidden." } }, 403);
    }

    const user = await services.getUser(userId);
    if (!user) {
      return c.json({ error: { code: "not_found", message: "User not found." } }, 404);
    }
    return c.json(user);
  });

  return app;
}
