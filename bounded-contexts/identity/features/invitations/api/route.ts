import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { InvitationId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import type { InvitationServices } from "./runtime";

function canManageInvitation(
  actor: IdentityApiEnv["Variables"]["actor"],
  invitation: Readonly<{ account_id: string }>,
) {
  return !actor || actor.roleKey === "platform-admin" || actor.accountId === invitation.account_id;
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.invitations.api.route.forbidden"),
    },
  };
}

export function invitationRoutes(services: InvitationServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const invitationId = body.invitationId as InvitationId;
    if (!canManageInvitation(c.var.actor, { account_id: String(body.accountId ?? "") })) {
      return c.json(forbidden(), 403);
    }
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: {
        type: "CreateInvitation",
        invitationId,
        accountId: body.accountId,
        email: body.email,
        roleKey: body.roleKey,
        expiresAt: body.expiresAt,
      },
      context: c.get("context"),
    });
    return c.json({ id: invitationId, version: result.version, status: result.state.status }, 201);
  });

  app.post("/:id/resend", async (c) => {
    const invitationId = c.req.param("id");
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
    const invitationId = c.req.param("id");
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
    const invitationId = c.req.param("id");
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
      search: actor && actor.roleKey !== "platform-admin" ? actor.accountId : search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const invitation = await services.getInvitationForRead(c.req.param("id"));
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
