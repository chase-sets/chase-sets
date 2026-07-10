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
  type RoleAssignmentAuthority,
  type RoleKey,
} from "../../../support/runtime-support/common";
import type { InvitationServices } from "./runtime";

type InvitationAccountReader = Readonly<{
  getAccountForRead: (accountId: string) => Promise<unknown | null>;
}>;

function canManageInvitation(
  actor: IdentityApiEnv["Variables"]["actor"],
  invitation: Readonly<{ account_id: string }>,
) {
  return !actor || actor.roleKey === PLATFORM_ADMIN_ROLE_KEY || actor.accountId === invitation.account_id;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.invitations.api.route.forbidden"),
    },
  };
}

function invalidRoleKey() {
  return {
    error: {
      code: "validation_failed",
      message: t("identity.features.invitations.api.route.role.key.invalid", {
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

function accountNotFound() {
  return {
    error: {
      code: "not_found",
      message: t("identity.features.invitations.api.route.account.not.found"),
    },
  };
}

export function invitationRoutes(services: InvitationServices, accounts: InvitationAccountReader) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const invitationId = parseTypedIdBoundary(body.invitationId, "ivt", "invitationId");
    const accountId = parseTypedIdBoundary(body.accountId, "acc", "accountId");
    if (!canManageInvitation(c.var.actor, { account_id: accountId })) {
      return c.json(forbidden(), 403);
    }
    const roleKey = parseGrantableRoleKey(body.roleKey);
    if (!roleKey) {
      return c.json(invalidRoleKey(), 400);
    }
    const roleKeyForActor = actorRoleKey(c.var.actor);
    if (c.var.actor && (!roleKeyForActor || !canAssignRole(roleKeyForActor, roleKey))) {
      return c.json(forbidden(), 403);
    }
    const account = await accounts.getAccountForRead(accountId);
    if (!account) {
      return c.json(accountNotFound(), 404);
    }
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: {
        type: "CreateInvitation",
        invitationId,
        accountId,
        email: body.email,
        roleKey,
        expiresAt: body.expiresAt,
        assignmentAuthority: assignmentAuthority(c.var.actor),
      },
      context: c.get("context"),
    });
    return c.json({ id: invitationId, version: result.version, status: result.state.status }, 201);
  });

  app.post("/:id/resend", async (c) => {
    const invitationId = parseTypedIdBoundary(c.req.param("id"), "ivt", "invitationId");
    const invitation = await services.getInvitationForRead(invitationId);
    if (!invitation) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.invitations.api.route.invitation.not.found") } },
        404,
      );
    }
    if (!canManageInvitation(c.var.actor, invitation)) {
      return c.json(forbidden(), 403);
    }
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "ResendInvitation", expiresAt: body.expiresAt },
      context: c.get("context"),
    });
    return c.json({ id: invitationId, version: result.version, status: result.state.status });
  });

  app.post("/:id/cancel", async (c) => {
    const invitationId = parseTypedIdBoundary(c.req.param("id"), "ivt", "invitationId");
    const invitation = await services.getInvitationForRead(invitationId);
    if (!invitation) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.invitations.api.route.invitation.not.found") } },
        404,
      );
    }
    if (!canManageInvitation(c.var.actor, invitation)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "CancelInvitation" },
      context: c.get("context"),
    });
    return c.json({ id: invitationId, version: result.version, status: result.state.status });
  });

  app.post("/:id/decline", async (c) => {
    const invitationId = parseTypedIdBoundary(c.req.param("id"), "ivt", "invitationId");
    const invitation = await services.getInvitationForRead(invitationId);
    if (!invitation) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.invitations.api.route.invitation.not.found") } },
        404,
      );
    }
    if (!canManageInvitation(c.var.actor, invitation)) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "DeclineInvitation" },
      context: c.get("context"),
    });
    return c.json({ id: invitationId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const actor = c.var.actor;
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listInvitations({
      search: actor && actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY ? actor.accountId : search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const invitationId = parseTypedIdBoundary(c.req.param("id"), "ivt", "invitationId");
    const invitation = await services.getInvitationForRead(invitationId);
    if (!invitation) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.invitations.api.route.invitation.not.found") } },
        404,
      );
    }
    if (!canManageInvitation(c.var.actor, invitation)) {
      return c.json(forbidden(), 403);
    }
    return c.json(invitation);
  });

  return app;
}
