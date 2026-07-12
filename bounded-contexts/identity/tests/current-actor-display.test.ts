import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { buildIdentityApi, type IdentityApiEnv } from "../api";
import type { IdentityServices } from "../support/runtime-support/services";
import {
  displayActorAccountName,
  displayActorUserName,
  displayRole,
  type CurrentActorDisplay,
} from "../support/shell-support/current-actor-display";

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
      getAccountForRead: vi.fn(async () => ({
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
      getMembershipState: vi.fn(async () => null),
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
    expect(services.accounts.getAccountForRead).toHaveBeenCalledWith("acc_1");
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

  it("uses command-side account and membership state when fresh actor projections have not caught up", async () => {
    const services = buildServices({
      accounts: {
        getAccountForRead: vi.fn(async () => ({
          account_id: "acc_1",
          account_type: "personal",
          badges: [],
          display_name: "Fresh Seller",
          name: "Fresh Seller",
          status: "active",
          updated_at: "",
        })),
      } as never,
      memberships: {
        getActiveMembershipForUserAccount: vi.fn(async () => null),
        getMembershipState: vi.fn(async () => ({
          id: "mbr_1",
          userId: "usr_1",
          accountId: "acc_1",
          roleKey: "owner",
          status: "active",
        })),
      } as never,
    });
    const response = await buildApp(services).request("/current-actor-display");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: {
        account_id: "acc_1",
        display_name: "Fresh Seller",
        name: "Fresh Seller",
      },
      membership: {
        membership_id: "mbr_1",
        role_key: "owner",
      },
    });
  });

  it("falls back to actor ids when identity projections have not caught up", async () => {
    const services = buildServices({
      accounts: { getAccountForRead: vi.fn(async () => null) } as never,
      memberships: {
        getActiveMembershipForUserAccount: vi.fn(async () => null),
        getMembershipState: vi.fn(async () => null),
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

describe("current actor display labels", () => {
  function display(
    overrides: {
      account?: Partial<CurrentActorDisplay["account"]>;
      user?: Partial<CurrentActorDisplay["user"]>;
    } = {},
  ): CurrentActorDisplay {
    return {
      account: {
        account_id: "acc_card_vault",
        display_name: null,
        name: null,
        badges: [],
        ...overrides.account,
      },
      membership: {
        membership_id: "mbr_card_vault_alex",
        role_key: "fulfillment_manager",
      },
      user: {
        user_id: "usr_alex",
        display_name: null,
        primary_email: null,
        ...overrides.user,
      },
    };
  }

  describe("displayActorAccountName", () => {
    it("prefers display_name", () => {
      expect(
        displayActorAccountName(display({ account: { display_name: "Card Vault", name: "Card Vault LLC" } })),
      ).toBe("Card Vault");
    });

    it("falls back to name when display_name is missing", () => {
      expect(displayActorAccountName(display({ account: { name: "Card Vault LLC" } }))).toBe("Card Vault LLC");
    });

    it("falls back to the account id when neither name is available", () => {
      expect(displayActorAccountName(display())).toBe("acc_card_vault");
    });
  });

  describe("displayActorUserName", () => {
    it("prefers display_name", () => {
      expect(
        displayActorUserName(display({ user: { display_name: "Alex Clerk", primary_email: "alex@example.com" } })),
      ).toBe("Alex Clerk");
    });

    it("falls back to primary_email when display_name is missing", () => {
      expect(displayActorUserName(display({ user: { primary_email: "alex@example.com" } }))).toBe("alex@example.com");
    });

    it("falls back to the user id when neither name nor email is available", () => {
      expect(displayActorUserName(display())).toBe("usr_alex");
    });
  });

  describe("displayRole", () => {
    it("formats underscore-separated role keys", () => {
      expect(displayRole("fulfillment_manager")).toBe("Fulfillment Manager");
    });

    it("formats hyphen-separated role keys", () => {
      expect(displayRole("platform-admin")).toBe("Platform Admin");
    });

    it("leaves already-readable role keys untouched", () => {
      expect(displayRole("owner")).toBe("Owner");
    });
  });
});
