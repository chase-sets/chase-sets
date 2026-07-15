import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import { membershipRoutes } from "./route";
import type { MembershipServices } from "./runtime";

type MembershipAccountReader = Parameters<typeof membershipRoutes>[1];

const actor: ResolvedActor = {
  sessionId: "ses_owner",
  tenantId: "tnt_identity",
  userId: "usr_owner",
  accountId: "acc_team",
  membershipId: "mbr_owner",
  roleKey: "owner",
  permissions: ["memberships.manage", "memberships.view"],
};

function buildApp(services: MembershipServices, accounts: MembershipAccountReader) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      tenantId: actor.tenantId,
      audit: {
        performedByUserId: actor.userId,
        forAccountId: actor.accountId,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/memberships", membershipRoutes(services, accounts));
  return app;
}

function createServices(
  overrides: Readonly<{
    activeOwnerCount?: number;
    accountStatus?: "active" | "suspended" | "closed";
    membershipRoleKey?: string;
  }> = {},
) {
  const commandHandler = vi.fn(async () => ({
    version: 2,
    state: { status: "active" },
    newEvents: [],
    storedEvents: [],
  }));
  const services = {
    commandHandler,
    getMembership: vi.fn(async () => ({
      membership_id: "mbr_owner",
      user_id: "usr_owner",
      account_id: "acc_team",
      role_key: overrides.membershipRoleKey ?? "owner",
      role_permissions: [],
      status: "active",
      user_display_name: "Owner",
      user_primary_email: "owner@example.com",
      account_display_name: "Team",
      account_name: "Team",
      updated_at: "2026-07-15T00:00:00.000Z",
    })),
    countActiveOwnersForAccount: vi.fn(async () => overrides.activeOwnerCount ?? 1),
    getMembershipState: vi.fn(async () => null),
    listMemberships: vi.fn(async () => ({ items: [], total: 0 })),
    getActiveMembershipForUserAccount: vi.fn(async () => null),
    listMembershipsForUser: vi.fn(async () => []),
    projectors: [],
  } as unknown as MembershipServices;
  const accounts = {
    getAccountState: vi.fn(async () => ({ status: overrides.accountStatus ?? "active" })),
  } satisfies MembershipAccountReader;
  return { services, accounts, commandHandler };
}

describe("membership owner invariant", () => {
  it.each([
    ["demote", "/memberships/mbr_owner/role", { method: "PUT", body: JSON.stringify({ roleKey: "manager" }) }],
    ["revoke", "/memberships/mbr_owner/revoke", { method: "POST" }],
  ])("rejects attempting to %s an account's last active owner", async (_operation, path, init) => {
    const { services, accounts, commandHandler } = createServices();
    const response = await buildApp(services, accounts).request(path, {
      ...init,
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("allows removing an owner when another active owner remains", async () => {
    const { services, accounts, commandHandler } = createServices({ activeOwnerCount: 2 });
    const response = await buildApp(services, accounts).request("/memberships/mbr_owner/revoke", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(commandHandler).toHaveBeenCalledOnce();
  });

  it("allows explicit membership teardown after the account is closed", async () => {
    const { services, accounts, commandHandler } = createServices({ accountStatus: "closed" });
    const response = await buildApp(services, accounts).request("/memberships/mbr_owner/revoke", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(services.countActiveOwnersForAccount).not.toHaveBeenCalled();
    expect(commandHandler).toHaveBeenCalledOnce();
  });

  it("does not query owner counts when changing a non-owner membership", async () => {
    const { services, accounts, commandHandler } = createServices({ membershipRoleKey: "manager" });
    const response = await buildApp(services, accounts).request("/memberships/mbr_owner/role", {
      method: "PUT",
      body: JSON.stringify({ roleKey: "viewer" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(services.countActiveOwnersForAccount).not.toHaveBeenCalled();
    expect(commandHandler).toHaveBeenCalledOnce();
  });
});
