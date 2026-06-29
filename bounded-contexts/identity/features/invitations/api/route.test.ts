import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import type { InvitationServices } from "./runtime";
import { invitationRoutes } from "./route";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["memberships.manage", "memberships.view"],
};

function buildApp(services: InvitationServices) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: {
        performedByUserId: actor.userId as never,
        forAccountId: actor.accountId as never,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/invitations", invitationRoutes(services));
  return app;
}

function buildServices(overrides: Partial<InvitationServices> = {}) {
  return {
    commandHandler: vi.fn(async () => ({
      state: { status: "cancelled" },
      version: 3,
    })),
    listInvitations: vi.fn(async () => ({ items: [], total: 0 })),
    getInvitation: vi.fn(async () => null),
    getInvitationForRead: vi.fn(async () => ({
      invitation_id: "ivt_1",
      account_id: actor.accountId,
      account_display_name: "Card Vault",
      account_name: "Card Vault LLC",
      email: "invitee@example.com",
      role_key: "viewer",
      status: "cancelled",
      expires_at: "2026-07-01T00:00:00.000Z",
      accepted_by_user_id: null,
      accepted_by_user_display_name: null,
      accepted_by_user_primary_email: null,
      updated_at: "",
    })),
    getInvitationState: vi.fn(async () => null),
    getPendingInvitationByEmail: vi.fn(async () => null),
    projectors: [],
    ...overrides,
  } as InvitationServices;
}

describe("invitation API route", () => {
  it("returns command-side invitation state for detail reads", async () => {
    const services = buildServices();

    const response = await buildApp(services).request("/invitations/ivt_1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      invitation_id: "ivt_1",
      account_id: actor.accountId,
      status: "cancelled",
    });
    expect(services.getInvitationForRead).toHaveBeenCalledWith("ivt_1");
  });

  it("uses command-side invitation state for cancel authorization prechecks", async () => {
    const services = buildServices();

    const response = await buildApp(services).request("/invitations/ivt_1/cancel", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "ivt_1",
      version: 3,
      status: "cancelled",
    });
    expect(services.getInvitationForRead).toHaveBeenCalledWith("ivt_1");
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "CancelInvitation" },
        streamId: "identity.invitation-ivt_1",
      }),
    );
  });
});
