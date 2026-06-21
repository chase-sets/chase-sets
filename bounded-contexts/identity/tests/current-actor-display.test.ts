import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { buildIdentityApi, type IdentityApiEnv } from "../api";
import type { IdentityServices } from "../support/runtime-support/services";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.view"],
};

function buildApp(services: IdentityServices, resolvedActor: ResolvedActor | null = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", resolvedActor);
    c.set("context", {
      tenantId: "tnt_1" as never,
      audit: {
        performedByUserId: actor.userId as never,
        forAccountId: actor.accountId as never,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/", buildIdentityApi(services));
  return app;
}

function buildServices(overrides: Partial<IdentityServices> = {}) {
  return {
    accounts: {
      getAccount: vi.fn(async () => ({
        account_id: "acc_1",
        badges: ["founding-account"],
        display_name: "Card Vault",
        name: "Card Vault LLC",
      })),
    },
    memberships: {
      getActiveMembershipForUserAccount: vi.fn(async () => ({
        membership_id: "mbr_1",
        role_key: "manager",
      })),
    },
    users: {
      getUser: vi.fn(async () => ({
        user_id: "usr_1",
        display_name: "Alex Clerk",
        primary_email: "alex@example.com",
      })),
      getUserState: vi.fn(async () => null),
    },
    ...overrides,
  } as IdentityServices;
}

describe("current actor display", () => {
  it("composes selected account, user, and membership facts for the current actor", async () => {
    const services = buildServices();
    const response = await buildApp(services).request("/current-actor-display");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      account: {
        account_id: "acc_1",
        badges: ["founding-account"],
        display_name: "Card Vault",
        name: "Card Vault LLC",
      },
      membership: {
        membership_id: "mbr_1",
        role_key: "manager",
      },
      user: {
        user_id: "usr_1",
        display_name: "Alex Clerk",
        primary_email: "alex@example.com",
      },
    });
    expect(services.accounts.getAccount).toHaveBeenCalledWith("acc_1");
    expect(services.memberships.getActiveMembershipForUserAccount).toHaveBeenCalledWith("usr_1", "acc_1");
    expect(services.users.getUser).toHaveBeenCalledWith("usr_1");
    expect(services.users.getUserState).toHaveBeenCalledWith("usr_1");
  });

  it("uses command-side user state when the user projection has not caught up", async () => {
    const services = buildServices({
      users: {
        getUser: vi.fn(async () => null),
        getUserState: vi.fn(async () => ({
          id: "usr_1",
          displayName: "Fresh Seller",
          givenName: "",
          familyName: "",
          status: "active",
          primaryEmail: "fresh-seller@example.com",
          contactMethods: [],
          authMethods: [],
          passwordCredentialId: null,
          passkeyCredentialIds: [],
          socialLoginLinks: [],
        })),
      } as never,
    });
    const response = await buildApp(services).request("/current-actor-display");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        user_id: "usr_1",
        display_name: "Fresh Seller",
        primary_email: "fresh-seller@example.com",
      },
    });
    expect(services.users.getUser).toHaveBeenCalledWith("usr_1");
    expect(services.users.getUserState).toHaveBeenCalledWith("usr_1");
  });

  it("falls back to actor ids when identity projections have not caught up", async () => {
    const services = buildServices({
      accounts: { getAccount: vi.fn(async () => null) } as never,
      memberships: {
        getActiveMembershipForUserAccount: vi.fn(async () => null),
      } as never,
      users: { getUser: vi.fn(async () => null), getUserState: vi.fn(async () => null) } as never,
    });
    const response = await buildApp(services).request("/current-actor-display");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      account: {
        account_id: "acc_1",
        badges: [],
        display_name: null,
        name: null,
      },
      membership: {
        membership_id: "mbr_1",
        role_key: "owner",
      },
      user: {
        user_id: "usr_1",
        display_name: null,
        primary_email: null,
      },
    });
  });

  it("requires an authenticated actor", async () => {
    const response = await buildApp(buildServices(), null).request("/current-actor-display");

    expect(response.status).toBe(401);
  });
});
