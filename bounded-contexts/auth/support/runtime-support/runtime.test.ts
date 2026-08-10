import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "./services";
import {
  AUTH_GUEST_CHECKOUT_PERMISSIONS,
  AUTH_GUEST_CHECKOUT_ROLE_KEY,
  AUTH_GUEST_CHECKOUT_USER_ID,
  resolveActorFromRequest,
} from "./runtime";

function createServices(options: {
  dbQuery?: AuthServices["db"]["query"];
  membership?: Awaited<ReturnType<AuthServices["identity"]["getActiveMembershipForUserAccount"]>>;
  session?: Awaited<ReturnType<AuthServices["sessions"]["getSession"]>>;
  user?: Awaited<ReturnType<AuthServices["identity"]["getUser"]>>;
}) {
  return {
    db: {
      query: options.dbQuery ?? vi.fn(async () => ({ rows: [] })),
    },
    auth: {
      hashSecret: vi.fn((secret: string) => `hashed:${secret}`),
    },
    identity: {
      bootstrapTenantId: "tnt_auth",
      getUser: vi.fn(async () => options.user ?? null),
      getActiveMembershipForUserAccount: vi.fn(async () => options.membership ?? null),
    },
    sessions: {
      getSession: vi.fn(async () => options.session ?? null),
      getSessionState: vi.fn(async () => null),
      readAuthenticatedSession: vi.fn(async () => null),
    },
  } as unknown as AuthServices;
}

describe("Auth request actor resolution", () => {
  it("resolves a browser session token through the auth session-token store", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const services = createServices({
      dbQuery: vi.fn(async () => ({
        rows: [
          {
            session_id: "ses_1",
            token_hash: "hashed:session_token",
            expires_at: expiresAt,
          },
        ],
      })),
      session: {
        session_id: "ses_1",
        user_id: "usr_1",
        user_display_name: null,
        user_primary_email: "seller@example.test",
        account_id: "acc_1",
        account_display_name: "Seller",
        account_name: "Seller",
        available_account_ids: ["acc_1"],
        authentication_method: "password",
        status: "active",
        expires_at: expiresAt,
        updated_at: expiresAt,
      },
      membership: {
        membership_id: "mem_1",
        user_id: "usr_1",
        account_id: "acc_1",
        role_key: "owner",
        role_permissions: ["accounts.view"],
        status: "active",
        updated_at: expiresAt,
      },
    });

    const actor = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/api/auth/session", {
        headers: { cookie: "chase_sets_session=session_token" },
      }),
    );

    expect(actor).toMatchObject({
      sessionId: "ses_1",
      tenantId: "tnt_identity",
      userId: "usr_1",
      accountId: "acc_1",
      membershipId: "mem_1",
      roleKey: "owner",
    });
    expect(actor?.permissions).toContain("accounts.view");
    expect(services.auth.hashSecret).toHaveBeenCalledWith("session_token");
  });

  it("restricts commerce write permissions until the user's email is verified", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const baseSession = {
      session_id: "ses_1",
      user_id: "usr_1",
      user_display_name: null,
      user_primary_email: "seller@example.test",
      account_id: "acc_1",
      account_display_name: "Seller",
      account_name: "Seller",
      available_account_ids: ["acc_1"],
      authentication_method: "password",
      status: "active",
      expires_at: expiresAt,
      updated_at: expiresAt,
    };
    const baseMembership = {
      membership_id: "mem_1",
      user_id: "usr_1",
      account_id: "acc_1",
      role_key: "owner",
      role_permissions: ["accounts.view", "listings.manage", "offers.manage", "orders.manage"],
      status: "active",
      updated_at: expiresAt,
    };
    const baseUser = {
      user_id: "usr_1",
      display_name: "Seller",
      given_name: "",
      family_name: "",
      primary_email: "seller@example.test",
      status: "active",
      contact_methods: [
        {
          contactMethodId: "ctm_email",
          type: "email",
          value: "seller@example.test",
          verifiedAt: null,
        },
      ],
      auth_methods: ["password"],
      password_credential_id: "crd_1",
      passkey_credential_ids: [],
      social_login_links: [],
      updated_at: expiresAt,
    };
    const dbQuery = vi.fn(async () => ({
      rows: [
        {
          session_id: "ses_1",
          token_hash: "hashed:session_token",
          expires_at: expiresAt,
        },
      ],
    }));
    const unverifiedServices = createServices({
      dbQuery,
      session: baseSession,
      membership: baseMembership,
      user: baseUser,
    });

    const unverifiedActor = await resolveActorFromRequest(
      unverifiedServices,
      new Request("https://platform.test/api/auth/session", {
        headers: { cookie: "chase_sets_session=session_token" },
      }),
    );

    expect(unverifiedActor?.permissions).toContain("accounts.view");
    expect(unverifiedActor?.permissions).not.toContain("listings.manage");
    expect(unverifiedActor?.permissions).not.toContain("offers.manage");
    expect(unverifiedActor?.permissions).not.toContain("orders.manage");

    const verifiedServices = createServices({
      dbQuery,
      session: baseSession,
      membership: baseMembership,
      user: {
        ...baseUser,
        contact_methods: [
          {
            contactMethodId: "ctm_email",
            type: "email",
            value: "seller@example.test",
            verifiedAt: "2026-07-06T12:00:00.000Z",
          },
        ],
      },
    });

    const verifiedActor = await resolveActorFromRequest(
      verifiedServices,
      new Request("https://platform.test/api/auth/session", {
        headers: { cookie: "chase_sets_session=session_token" },
      }),
    );

    expect(verifiedActor?.permissions).toEqual(
      expect.arrayContaining(["accounts.view", "listings.manage", "offers.manage", "orders.manage"]),
    );
  });

  it("defines the guest checkout actor shape inside Auth", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const services = createServices({
      dbQuery: vi.fn(async () => ({
        rows: [
          {
            token_id: "tok_guest",
            account_id: "acc_guest",
            contact_email: "guest@example.test",
            contact_name: "Guest Buyer",
            token_hash: "hashed:guest_token",
            expires_at: expiresAt,
            revoked_at: null,
          },
        ],
      })),
    });

    const actor = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/api/checkout", {
        headers: { cookie: "chase_sets_guest_checkout=guest_token" },
      }),
    );

    expect(actor).toEqual({
      sessionId: "guest:tok_guest",
      tenantId: "tnt_auth",
      userId: AUTH_GUEST_CHECKOUT_USER_ID,
      accountId: "acc_guest",
      membershipId: "guest:tok_guest",
      roleKey: AUTH_GUEST_CHECKOUT_ROLE_KEY,
      permissions: AUTH_GUEST_CHECKOUT_PERMISSIONS,
    });
    expect(services.auth.hashSecret).toHaveBeenCalledWith("guest_token");
  });

  it("resolves UCP access-token actors with Auth-owned scope permission policy", async () => {
    const services = createServices({
      membership: {
        membership_id: "mem_1",
        user_id: "usr_1",
        account_id: "acc_1",
        role_key: "owner",
        role_permissions: ["accounts.view", "catalog.view", "listings.view", "orders.manage", "orders.view"],
        status: "active",
        updated_at: new Date().toISOString(),
      },
    });
    const linkedPlatformAuthorizations = {
      resolveAccessToken: vi.fn(async () => ({
        authorization_id: "lpa_1",
        user_id: "usr_1",
        account_id: "acc_1",
        scopes: ["catalog:read", "checkout:write"],
      })),
    };

    const actor = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/ucp/v1/catalog", {
        headers: { authorization: "Bearer ucp_at_secret" },
      }),
      { linkedPlatformAuthorizations },
    );

    expect(actor).toEqual({
      sessionId: "ucp:lpa_1",
      tenantId: "tnt_auth",
      userId: "usr_1",
      accountId: "acc_1",
      membershipId: "mem_1",
      roleKey: "owner",
      permissions: ["catalog.view", "orders.manage"],
      agentGrant: {
        grantId: "lpa_1",
        scopes: ["catalog:read", "checkout:write"],
        rolePermissions: ["accounts.view", "catalog.view", "listings.view", "orders.manage", "orders.view"],
      },
    });
    expect(linkedPlatformAuthorizations.resolveAccessToken).toHaveBeenCalledWith("hashed:ucp_at_secret");
  });

  it("intersects linked OAuth scopes with the member role permissions", async () => {
    const services = createServices({
      membership: {
        membership_id: "mem_1",
        user_id: "usr_1",
        account_id: "acc_1",
        role_key: "viewer",
        role_permissions: ["payouts.view"],
        status: "active",
        updated_at: new Date().toISOString(),
      },
    });
    const linkedPlatformAuthorizations = {
      resolveAccessToken: vi.fn(async () => ({
        authorization_id: "lpa_1",
        user_id: "usr_1",
        account_id: "acc_1",
        scopes: ["payouts:request"],
      })),
    };

    const actor = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/mcp", {
        headers: { authorization: "Bearer ucp_at_secret" },
      }),
      { linkedPlatformAuthorizations },
    );

    expect(actor).toMatchObject({
      sessionId: "ucp:lpa_1",
      roleKey: "viewer",
      permissions: [],
      agentGrant: {
        grantId: "lpa_1",
        scopes: ["payouts:request"],
        rolePermissions: ["payouts.view"],
      },
    });
  });
});
