import { Hono } from "hono";
import type { IdentityApiEnv } from "../../../api";
import { hasPermission } from "../../../support/request-support/permissions";
import type { ConsentServices } from "./runtime";

export function consentRoutes(services: ConsentServices) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset, userId, accountId } = c.req.query();
    const result = await services.listConsents({
      search,
      status,
      userId: actor && !hasPermission(actor, "security.manage") ? actor.userId : userId,
      accountId: actor && !hasPermission(actor, "security.manage") ? actor.accountId : accountId,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  return app;
}
