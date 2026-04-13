import { Hono } from "hono";
import type { MembershipId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { hasPermission } from "../../../support/request-support/permissions";
import type { MembershipServices } from "./runtime";

export function membershipRoutes(services: MembershipServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const membershipId = body.membershipId as MembershipId;
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: {
        type: "GrantMembership",
        membershipId,
        userId: body.userId,
        accountId: body.accountId,
        roleKey: body.roleKey,
      },
      context: c.get("context"),
    });
    return c.json({ id: membershipId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id/role", async (c) => {
    const membershipId = c.req.param("id");
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "ChangeMembershipRole", roleKey: body.roleKey },
      context: c.get("context"),
    });
    return c.json({ id: membershipId, version: result.version, status: result.state.status });
  });

  app.post("/:id/revoke", async (c) => {
    const membershipId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "RevokeMembership" },
      context: c.get("context"),
    });
    return c.json({ id: membershipId, version: result.version, status: result.state.status });
  });

  app.post("/:id/reinstate", async (c) => {
    const membershipId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "ReinstateMembership" },
      context: c.get("context"),
    });
    return c.json({ id: membershipId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listMemberships({
      search:
        actor && !hasPermission(actor, "memberships.manage")
          ? actor.userId
          : search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const membership = await services.getMembership(c.req.param("id"));
    if (!membership) {
      return c.json({ error: "Membership not found." }, 404);
    }
    const actor = c.var.actor;
    if (
      actor &&
      !hasPermission(actor, "memberships.manage") &&
      membership.user_id !== actor.userId
    ) {
      return c.json({ error: "Forbidden." }, 403);
    }
    return c.json(membership);
  });

  return app;
}
