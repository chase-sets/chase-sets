import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createIdentityOperatorAuthority } from "@chase-sets/identity/server";
import { createMcpRoutes, type McpToolHandlerInput } from "@chase-sets/platform-runtime/mcp";
import type { AuthenticatedSessionRead } from "../../features/sessions/api/runtime";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import { createAuthServices, type AuthServices } from "./services";
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
  authenticatedSession?: AuthenticatedSessionRead | null;
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
      readAuthenticatedSession: vi.fn(async () =>
        options.authenticatedSession === undefined
          ? toAuthenticatedSessionRead(options.session ?? null)
          : options.authenticatedSession,
      ),
    },
  } as unknown as AuthServices;
}

function toAuthenticatedSessionRead(
  session: Awaited<ReturnType<AuthServices["sessions"]["getSession"]>> | null,
): AuthenticatedSessionRead | null {
  if (!session) {
    return null;
  }

  return {
    state: {
      id: session.session_id,
      userId: session.user_id,
      accountId: session.account_id,
      availableAccountIds: session.available_account_ids,
      authenticationMethod: session.authentication_method,
      status: session.status,
      expiresAt: session.expires_at,
    } as AuthenticatedSessionRead["state"],
    authenticatedAt: session.started_at ?? null,
  };
}

describe("Auth request actor resolution", () => {
  it.each([
    // retired scope fixture: old authority is not upgraded to capability scopes or defaults.
    { scopes: ["checkout:write", "order:read"], expectedScopes: [], permissions: [] },
    {
      scopes: ["checkout:write", "inventory:read"],
      expectedScopes: ["inventory:read"],
      permissions: ["inventory.view"],
    },
  ])("stored buyer grants keep only registered scopes: $scopes", async ({ scopes, expectedScopes, permissions }) => {
    const services = createServices({
      membership: {
        membership_id: "mem_retired",
        user_id: "usr_retired",
        account_id: "acc_retired",
        role_key: "owner",
        role_permissions: ["catalog.view", "orders.view", "orders.manage", "inventory.view"],
        status: "active",
        updated_at: "2026-10-12T00:00:00.000Z",
      },
    });
    const actor = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/mcp", {
        headers: { authorization: "Bearer ucp_at_retired" },
      }),
      {
        linkedPlatformAuthorizations: {
          resolveAccessToken: vi.fn(async () => ({
            authorization_id: "lpa_retired",
            platform_profile_url: "https://agent.example/.well-known/ucp",
            user_id: "usr_retired",
            account_id: "acc_retired",
            scopes,
          })),
        },
      },
    );
    expect(actor?.permissions).toEqual(permissions);
    expect(actor?.agentGrant?.scopes).toEqual(expectedScopes);
  });

  it.each(["owner", "manager"])("applies pricing email boundaries for %s", async (roleKey) => {
    for (const emailState of [
      "unverified",
      "verified-contact",
      "google",
      "facebook",
      "social-link",
      "no-primary-email",
    ]) {
      const expiresAt = "2099-01-01T00:00:00.000Z";
      const services = createServices({
        dbQuery: vi.fn(async () => ({
          rows: [{ session_id: "ses_synthetic_pricing", token_hash: "hashed:synthetic_token", expires_at: expiresAt }],
        })),
        session: {
          session_id: "ses_synthetic_pricing",
          user_id: "usr_synthetic_pricing",
          user_display_name: null,
          user_primary_email: null,
          account_id: "acc_synthetic_pricing",
          account_display_name: null,
          account_name: null,
          available_account_ids: ["acc_synthetic_pricing"],
          authentication_method: ["google", "facebook"].includes(emailState) ? emailState : "password",
          status: "active",
          expires_at: expiresAt,
          updated_at: expiresAt,
        },
        membership: {
          membership_id: "mbr_synthetic_pricing",
          user_id: "usr_synthetic_pricing",
          account_id: "acc_synthetic_pricing",
          role_key: roleKey,
          role_permissions: [],
          status: "active",
          updated_at: expiresAt,
        },
        user: {
          user_id: "usr_synthetic_pricing",
          display_name: "Synthetic",
          given_name: "",
          family_name: "",
          primary_email: emailState === "no-primary-email" ? null : "synthetic@example.test",
          status: "active",
          contact_methods: [
            {
              type: "email",
              value: "SYNTHETIC@example.test",
              verifiedAt: emailState === "verified-contact" ? "2026-09-01T00:00:00Z" : null,
            },
          ],
          social_login_links: emailState === "social-link" ? [{ email: "SYNTHETIC@example.test" }] : [],
          auth_methods: ["password"],
          password_credential_id: null,
          passkey_credential_ids: [],
          updated_at: expiresAt,
        },
      });
      const actor = await resolveActorFromRequest(
        services,
        new Request("https://platform.test/api/auth/session", {
          headers: { cookie: "chase_sets_session=synthetic_token" },
        }),
      );
      expect(actor?.permissions, emailState).toContain("pricing.view");
      for (const permission of ["pricing.manage", "listings.manage", "offers.manage", "orders.manage"]) {
        expect(actor?.permissions.includes(permission), emailState + ":" + permission).toBe(
          emailState !== "unverified",
        );
      }
      if (emailState === "unverified") {
        // Stored-grant control, deliberately separate from the preset-positive resolution above.
        const membership = await services.identity.getActiveMembershipForUserAccount(
          "usr_synthetic_pricing",
          "acc_synthetic_pricing",
        );
        vi.mocked(services.identity.getActiveMembershipForUserAccount).mockResolvedValue({
          ...membership!,
          role_key: "viewer",
          role_permissions: ["pricing.manage", "synthetic.retained"],
        });
        const storedActor = await resolveActorFromRequest(
          services,
          new Request("https://platform.test/api/auth/session", {
            headers: { cookie: "chase_sets_session=synthetic_token" },
          }),
        );
        expect(storedActor?.permissions).not.toContain("pricing.manage");
        expect(storedActor?.permissions).toContain("pricing.view");
        expect(storedActor?.permissions).toContain("synthetic.retained");
      }
    }
  });
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
            contact_email: null,
            contact_name: null,
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

  it("falls back to the guest actor when authoritative Session resolution denies", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const dbQuery = vi.fn(async (sql: unknown) => ({
      rows: String(sql).includes("identity_session_tokens")
        ? [{ session_id: "ses_revoked", token_hash: "hashed:session_token", expires_at: expiresAt }]
        : [
            {
              token_id: "tok_guest_fallback",
              account_id: "acc_guest_fallback",
              token_hash: "hashed:guest_token",
              expires_at: expiresAt,
              revoked_at: null,
            },
          ],
    }));
    const services = createServices({
      dbQuery: dbQuery as AuthServices["db"]["query"],
      authenticatedSession: null,
    });

    const actor = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/api/checkout", {
        headers: {
          cookie: "chase_sets_session=session_token; chase_sets_guest_checkout=guest_token",
        },
      }),
    );

    expect(actor).toMatchObject({
      sessionId: "guest:tok_guest_fallback",
      accountId: "acc_guest_fallback",
      roleKey: AUTH_GUEST_CHECKOUT_ROLE_KEY,
    });
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
        platform_profile_url: "https://agent.example/.well-known/ucp",
        user_id: "usr_1",
        account_id: "acc_1",
        scopes: ["catalog:read", "dev.ucp.shopping.checkout:manage"],
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
      permissions: ["catalog.view", "orders.manage", "orders.view"],
      agentGrant: {
        grantId: "lpa_1",
        platformProfileUrl: "https://agent.example/.well-known/ucp",
        scopes: ["catalog:read", "dev.ucp.shopping.checkout:manage"],
        rolePermissions: ["accounts.view", "catalog.view", "listings.view", "orders.manage", "orders.view"],
      },
    });
    expect(linkedPlatformAuthorizations.resolveAccessToken).toHaveBeenCalledWith("hashed:ucp_at_secret");
  });

  it("keeps UCP bearer precedence over Session and guest cookies", async () => {
    const dbQuery = vi.fn(async () => ({ rows: [] }));
    const services = createServices({
      dbQuery,
      membership: {
        membership_id: "mem_ucp_precedence",
        user_id: "usr_ucp_precedence",
        account_id: "acc_ucp_precedence",
        role_key: "owner",
        role_permissions: ["catalog.view"],
        status: "active",
        updated_at: new Date().toISOString(),
      },
    });
    const linkedPlatformAuthorizations = {
      resolveAccessToken: vi.fn(async () => ({
        authorization_id: "lpa_precedence",
        platform_profile_url: "https://agent.example/.well-known/ucp",
        user_id: "usr_ucp_precedence",
        account_id: "acc_ucp_precedence",
        scopes: ["catalog:read"],
      })),
    };

    const actor = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/ucp/v1/catalog", {
        headers: {
          authorization: "Bearer ucp_at_precedence",
          cookie: "chase_sets_session=session_token; chase_sets_guest_checkout=guest_token",
        },
      }),
      { linkedPlatformAuthorizations },
    );

    expect(actor?.sessionId).toBe("ucp:lpa_precedence");
    expect(dbQuery).not.toHaveBeenCalled();
    expect(services.sessions.readAuthenticatedSession).not.toHaveBeenCalled();
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
        platform_profile_url: "https://agent.example/.well-known/ucp",
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

describe("operator authority reads aggregate", () => {
  const offerEconomicsTool = "platform-operations.get-offer-economics-summary";
  const linkedPlatformAuthorizations = {
    resolveAccessToken: vi.fn(async () => ({
      authorization_id: "lpa_operator",
      platform_profile_url: "https://agent.example/.well-known/ucp",
      user_id: "usr_op",
      account_id: "acc_op",
      scopes: ["catalog:read", "operations:write"],
    })),
  };

  async function resolveOperatorBearer(aggregateRoleKey: "platform-admin" | "owner") {
    const services = createServices({
      // The projection is stale: it still says platform-admin after the aggregate changed.
      membership: {
        membership_id: "mem_op",
        user_id: "usr_op",
        account_id: "acc_op",
        role_key: "platform-admin",
        role_permissions: [...AUTH_ROLE_PERMISSIONS["platform-admin"]],
        status: "active",
        updated_at: new Date().toISOString(),
      },
    });
    const getMembershipState = vi.fn(async () => ({
      id: "mem_op",
      userId: "usr_op",
      accountId: "acc_op",
      roleKey: aggregateRoleKey,
      status: "active",
    }));
    const operatorAuthority = createIdentityOperatorAuthority({ getMembershipState } as never);
    const actor = await resolveActorFromRequest(
      { ...services, identity: { ...services.identity, operatorAuthority } } as AuthServices,
      new Request("https://platform.test/mcp", { headers: { authorization: "Bearer ucp_at_operator" } }),
      { linkedPlatformAuthorizations },
    );
    return { actor: actor!, operatorAuthority, getMembershipState };
  }

  async function callOfferEconomics(
    actor: ResolvedActor,
    operatorAuthority: AuthServices["identity"]["operatorAuthority"],
  ) {
    const handler = vi.fn(async (_input: McpToolHandlerInput) => ({ snapshot: {} }));
    const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.route("/", createMcpRoutes({ operatorAuthority, toolHandlers: { [offerEconomicsTool]: handler } }));
    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: offerEconomicsTool } }),
    });
    return { text: await response.text(), handler };
  }

  it("refuses the next operator call once the aggregate is demoted, whatever the projection says", async () => {
    const { actor, operatorAuthority, getMembershipState } = await resolveOperatorBearer("owner");

    // The same bearer on an HTTP route holds only its commerce scopes' permissions.
    expect(actor.roleKey).toBe("platform-admin");
    expect(actor.permissions).toEqual(["catalog.view"]);
    expect(actor.agentGrant?.scopes).toEqual(["catalog:read", "operations:write"]);

    const refused = await callOfferEconomics(actor, operatorAuthority);
    expect(refused.text).toContain("This MCP capability is not available to the authenticated actor.");
    expect(refused.handler).not.toHaveBeenCalled();
    expect(getMembershipState).toHaveBeenCalledWith("mem_op");
  });

  it("admits the same bearer while the aggregate is platform-admin, without widening its HTTP actor", async () => {
    const { actor, operatorAuthority } = await resolveOperatorBearer("platform-admin");

    expect(actor.permissions).toEqual(["catalog.view"]);
    const admitted = await callOfferEconomics(actor, operatorAuthority);
    expect(admitted.handler).toHaveBeenCalledTimes(1);
    expect(admitted.handler.mock.calls[0]![0]).toMatchObject({
      actor: { permissions: expect.arrayContaining(["insights-dashboards.view"]), roleKey: "platform-admin" },
    });
  });

  it("carries the host-supplied operator authority on Auth's identity port", () => {
    const operatorAuthority = vi.fn();
    const pool = { query: vi.fn(), connect: vi.fn() } as never;
    expect(createAuthServices(pool, { operatorAuthority }).identity.operatorAuthority).toBe(operatorAuthority);
    expect(createAuthServices(pool).identity.operatorAuthority).toBeUndefined();
  });
});
