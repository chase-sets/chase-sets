import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
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

type InvitationAccountReader = Parameters<typeof invitationRoutes>[1];

function buildAccounts(overrides: Partial<InvitationAccountReader> = {}): InvitationAccountReader {
  return {
    getAccountForRead: vi.fn(async () => ({
      account_id: actor.accountId,
      name: "Card Vault LLC",
      display_name: "Card Vault",
      account_type: "business",
      status: "active",
      badges: [],
      updated_at: "2026-07-01T00:00:00.000Z",
    })),
    ...overrides,
  };
}

function buildApp(services: InvitationServices, accounts = buildAccounts(), requestActor = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("actor", requestActor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: {
        performedByUserId: requestActor.userId as never,
        forAccountId: requestActor.accountId as never,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/invitations", invitationRoutes(services, accounts));
  return app;
}

function buildServices(overrides: Partial<InvitationServices> = {}) {
  return {
    commandHandler: vi.fn(async (input: { command: { type: string } }) => ({
      state: { status: input.command.type === "CreateInvitation" ? "pending" : "cancelled" },
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
  it("rejects malformed account IDs before issuing create commands", async () => {
    const services = buildServices();
    const accounts = buildAccounts();

    const response = await buildApp(services, accounts).request("/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        accountId: "usr_1",
        email: "invitee@example.com",
        roleKey: "viewer",
        expiresAt: "2026-07-08T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "accountId must start with acc_.",
      },
    });
    expect(accounts.getAccountForRead).not.toHaveBeenCalled();
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("returns 400 for a wrong-kind invitation ID before issuing create commands", async () => {
    const services = buildServices();
    const accounts = buildAccounts();

    const response = await buildApp(services, accounts).request("/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "usr_1",
        accountId: "acc_1",
        email: "invitee@example.com",
        roleKey: "viewer",
        expiresAt: "2026-07-08T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "invitationId must start with ivt_.",
      },
    });
    expect(accounts.getAccountForRead).not.toHaveBeenCalled();
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects unknown accounts before issuing create commands", async () => {
    const services = buildServices();
    const accounts = buildAccounts({ getAccountForRead: vi.fn(async () => null) });

    const response = await buildApp(services, accounts).request("/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        accountId: "acc_1",
        email: "invitee@example.com",
        roleKey: "viewer",
        expiresAt: "2026-07-08T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "not_found",
        message: expect.stringContaining("Select an existing account"),
      },
    });
    expect(accounts.getAccountForRead).toHaveBeenCalledWith("acc_1");
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("creates invitations for known accounts", async () => {
    const services = buildServices();
    const accounts = buildAccounts();

    const response = await buildApp(services, accounts).request("/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        accountId: "acc_1",
        email: "invitee@example.com",
        roleKey: "viewer",
        expiresAt: "2026-07-08T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "ivt_1",
      version: 3,
      status: "pending",
    });
    expect(accounts.getAccountForRead).toHaveBeenCalledWith("acc_1");
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "identity.invitation-ivt_1",
        command: expect.objectContaining({
          type: "CreateInvitation",
          accountId: "acc_1",
        }),
      }),
    );
  });

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
