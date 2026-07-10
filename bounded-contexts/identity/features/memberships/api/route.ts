import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { IdentityApiEnv } from "../../../api";
import {
  canAssignRole,
  formatGrantableRoleKeys,
  parseGrantableRoleKey,
  parseRoleKey,
  PLATFORM_ADMIN_ROLE_KEY,
  type GrantableRoleKey,
  type RoleAssignmentAuthority,
  type RoleKey,
} from "../../../support/runtime-support/common";
import type { MembershipServices } from "./runtime";

function canManageMembership(
  actor: IdentityApiEnv["Variables"]["actor"],
  membership: Readonly<{ user_id: string; account_id: string }>,
) {
  return !actor || actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.accountId === membership.account_id;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.memberships.api.route.forbidden"),
    },
  };
}

function invalidRoleKey() {
  return {
    error: {
      code: "validation_failed",
      message: t("identity.features.memberships.api.route.role.key.invalid", {
        validRoleKeys: formatGrantableRoleKeys(),
      }),
    },
  };
}

function actorRoleKey(actor: IdentityApiEnv["Variables"]["actor"]): RoleKey | null {
  return actor ? parseRoleKey(actor.roleKey) : null;
}

function assignmentAuthority(actor: IdentityApiEnv["Variables"]["actor"]): RoleAssignmentAuthority {
  const roleKey = actorRoleKey(actor);
  return roleKey ? { type: "actor", roleKey } : { type: "system" };
}

function canAssignRequestedRole(actor: IdentityApiEnv["Variables"]["actor"], roleKey: GrantableRoleKey) {
  const roleKeyForActor = actorRoleKey(actor);
  return !actor || (roleKeyForActor ? canAssignRole(roleKeyForActor, roleKey) : false);
}

export function membershipRoutes(services: MembershipServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const membershipId = parseTypedIdBoundary(body.membershipId, "mbr", "membershipId");
    const userId = parseTypedIdBoundary(body.userId, "usr", "userId");
    const accountId = parseTypedIdBoundary(body.accountId, "acc", "accountId");
    if (
      !canManageMembership(c.var.actor, {
        user_id: userId,
        account_id: accountId,
      })
    ) {
      return c.json(forbidden(), 403);
    }
    const roleKey = parseGrantableRoleKey(body.roleKey);
    if (!roleKey) {
      return c.json(invalidRoleKey(), 400);
    }
    if (!canAssignRequestedRole(c.var.actor, roleKey)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: {
        type: "GrantMembership",
        membershipId,
        userId,
        accountId,
        roleKey,
        assignmentAuthority: assignmentAuthority(c.var.actor),
      },
      context: c.get("context"),
    });
    return c.json({ id: membershipId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id/role", async (c) => {
    const membershipId = parseTypedIdBoundary(c.req.param("id"), "mbr", "membershipId");
    const membership = await services.getMembership(membershipId);
    if (!membership) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.memberships.api.route.membership.not.found") } },
        404,
      );
    }
    if (!canManageMembership(c.var.actor, membership)) {
      return c.json(forbidden(), 403);
    }
    const body = await c.req.json();
    const roleKey = parseGrantableRoleKey(body.roleKey);
    if (!roleKey) {
      return c.json(invalidRoleKey(), 400);
    }
    if (!canAssignRequestedRole(c.var.actor, roleKey)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "ChangeMembershipRole", roleKey, assignmentAuthority: assignmentAuthority(c.var.actor) },
      context: c.get("context"),
    });
    return c.json({ id: membershipId, version: result.version, status: result.state.status });
  });

  app.post("/:id/revoke", async (c) => {
    const membershipId = parseTypedIdBoundary(c.req.param("id"), "mbr", "membershipId");
    const membership = await services.getMembership(membershipId);
    if (!membership) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.memberships.api.route.membership.not.found") } },
        404,
      );
    }
    if (!canManageMembership(c.var.actor, membership)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: { type: "RevokeMembership" },
      context: c.get("context"),
    });
    return c.json({ id: membershipId, version: result.version, status: result.state.status });
  });

  app.post("/:id/reinstate", async (c) => {
    const membershipId = parseTypedIdBoundary(c.req.param("id"), "mbr", "membershipId");
    const membership = await services.getMembership(membershipId);
    if (!membership) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.memberships.api.route.membership.not.found") } },
        404,
      );
    }
    if (!canManageMembership(c.var.actor, membership)) {
      return c.json(forbidden(), 403);
    }
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
      search: actor && actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY ? actor.accountId : search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const membership = await services.getMembership(c.req.param("id"));
    if (!membership) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.memberships.api.route.membership.not.found") } },
        404,
      );
    }
    const actor = c.var.actor;
    if (actor && !canManageMembership(actor, membership)) {
      return c.json(forbidden(), 403);
    }
    return c.json(membership);
  });

  return app;
}
