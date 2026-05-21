import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { InvitationId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import type { InvitationServices } from "./runtime";

export function invitationRoutes(services: InvitationServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const invitationId = body.invitationId as InvitationId;
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
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "CancelInvitation" },
      context: c.get("context"),
    });
    return c.json({ id: invitationId, version: result.version, status: result.state.status });
  });

  app.post("/:id/decline", async (c) => {
    const invitationId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "DeclineInvitation" },
      context: c.get("context"),
    });
    return c.json({ id: invitationId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listInvitations({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const invitation = await services.getInvitation(c.req.param("id"));
    if (!invitation) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.invitations.api.route.invitation.not.found") } },
        404,
      );
    }
    return c.json(invitation);
  });

  return app;
}
