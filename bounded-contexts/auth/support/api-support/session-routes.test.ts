import type { ResolvedActor } from "@chase-sets/auth-context";
import {
  createAccountUserTestActor,
  createAdminTestActor,
  createAnonymousTestActor,
  createTestApp,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import { createAuthServicesFake } from "../auth-support/test-support";
import { AUTH_GUEST_CHECKOUT_COOKIE_NAME, AUTH_SESSION_COOKIE_NAME } from "../request-support/cookies";
import type { AuthServices } from "../runtime-support/services";
import { registerSessionApiRoutes } from "./session-routes";
import type { AuthApiEnv } from "./support";

const SESSION_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
const SESSION_AUTHENTICATED_AT = new Date(Date.now() - 1_000).toISOString();
const SESSION_COOKIE = `${AUTH_SESSION_COOKIE_NAME}=session_token`;
const GUEST_COOKIE = `${AUTH_GUEST_CHECKOUT_COOKIE_NAME}=guest_token`;

const VERIFIED_USER = {
  user_id: "usr_test",
  primary_email: "seller@example.test",
  status: "active",
  contact_methods: [
    {
      contactMethodId: "ctm_email",
      type: "email",
      value: "seller@example.test",
      verifiedAt: "2026-07-06T12:00:00.000Z",
    },
  ],
  social_login_links: [],
};

const FRESH_MEMBERSHIP = {
  membership_id: "mbr_fresh",
  user_id: "usr_test",
  account_id: "acc_test",
  role_key: "owner",
  role_permissions: ["accounts.view"],
  status: "active",
  updated_at: new Date().toISOString(),
};

/** The `identity_session_tokens` row the fake `db.query` returns for the session cookie. */
const SESSION_TOKEN_ROW = {
  session_id: "ses_test",
  token_hash: "hashed:session_token",
  expires_at: SESSION_EXPIRES_AT,
};

/** The `identity_guest_checkout_tokens` row the fake `db.query` returns for the guest cookie. */
const GUEST_TOKEN_ROW = {
  token_id: "tok_guest",
  account_id: "acc_guest",
  contact_email: null,
  contact_name: null,
  token_hash: "hashed:guest_token",
  expires_at: SESSION_EXPIRES_AT,
  revoked_at: null,
};

function createAuthenticatedSession(status: "active" | "revoked" = "active", expiresAt = SESSION_EXPIRES_AT) {
  return {
    state: {
      id: "ses_test",
      userId: "usr_test",
      accountId: "acc_test",
      availableAccountIds: ["acc_test"],
      authenticationMethod: "password",
      status,
      expiresAt,
    },
    authenticatedAt: SESSION_AUTHENTICATED_AT,
  };
}

function buildApp(services: AuthServices, actor: ResolvedActor | null) {
  return createTestApp<AuthApiEnv>({
    actor,
    routes: (app) => {
      registerSessionApiRoutes(app, services);
    },
  });
}

function createServices(
  overrides: Readonly<{
    listSessions?: ReturnType<typeof vi.fn>;
    dbRows?: readonly Record<string, unknown>[];
    user?: Record<string, unknown> | null;
    membership?: Record<string, unknown> | null;
    authenticatedSession?: ReturnType<typeof createAuthenticatedSession> | null;
  }> = {},
) {
  const authenticatedSession =
    overrides.authenticatedSession === undefined ? createAuthenticatedSession() : overrides.authenticatedSession;
  return createAuthServicesFake({
    db: { query: vi.fn(async () => ({ rows: [...(overrides.dbRows ?? [])] })) },
    identity: {
      bootstrapTenantId: "tnt_identity",
      getUser: vi.fn(async () => (overrides.user === undefined ? VERIFIED_USER : overrides.user)),
      getActiveMembershipForUserAccount: vi.fn(async () =>
        overrides.membership === undefined ? FRESH_MEMBERSHIP : overrides.membership,
      ),
    },
    sessions: {
      commandHandler: vi.fn(async (input: { command: Record<string, unknown> }) => ({
        version: 2,
        state: {
          status: input.command.type === "RevokeSession" ? "revoked" : "active",
        },
      })),
      readAuthenticatedSession: vi.fn(async (sessionId: string) =>
        sessionId === "ses_test" ? authenticatedSession : null,
      ),
      listSessions: overrides.listSessions ?? vi.fn(async () => ({ items: [], total: 0 })),
    },
  });
}

useMockReset();

describe("session auth routes", () => {
  it("requires authentication to read the current session", async () => {
    const services = createServices();
    const app = buildApp(services, createAnonymousTestActor());

    const response = await app.request("/session");

    expect(response.status).toBe(401);
  });

  it("returns the freshly resolved session actor instead of the pre-wait actor", async () => {
    const services = createServices({ dbRows: [SESSION_TOKEN_ROW] });
    // The host-resolved actor was computed before the read-consistency wait,
    // from a stale user projection that withheld the commerce permissions.
    const preWaitActor = createAccountUserTestActor({ membershipId: "mbr_stale", permissions: ["accounts.view"] });
    const app = buildApp(services, preWaitActor);

    const response = await app.request("/session", { headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { actor: ResolvedActor };
    expect(body.actor).toMatchObject({
      sessionId: "ses_test",
      tenantId: "tnt_identity",
      userId: "usr_test",
      accountId: "acc_test",
      membershipId: "mbr_fresh",
      roleKey: "owner",
      authenticatedAt: SESSION_AUTHENTICATED_AT,
    });
    expect(body.actor.permissions).toEqual(expect.arrayContaining(["accounts.view", "offers.manage"]));
    expect(body.actor).not.toEqual(preWaitActor);
    expect(services.identity.getUser).toHaveBeenCalledWith("usr_test");
    expect(services.identity.getActiveMembershipForUserAccount).toHaveBeenCalledWith("usr_test", "acc_test");
  });

  it("serves HEAD /session through the same fresh resolution as GET", async () => {
    const services = createServices({ dbRows: [SESSION_TOKEN_ROW] });
    const app = buildApp(services, createAccountUserTestActor({ permissions: ["accounts.view"] }));

    const response = await app.request("/session", { method: "HEAD", headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(services.identity.getUser).toHaveBeenCalledWith("usr_test");
  });

  it("keeps withholding commerce permissions when the fresh user projection is still unverified", async () => {
    const services = createServices({
      dbRows: [SESSION_TOKEN_ROW],
      user: {
        ...VERIFIED_USER,
        contact_methods: [{ ...VERIFIED_USER.contact_methods[0], verifiedAt: null }],
      },
    });
    const app = buildApp(services, createAccountUserTestActor({ permissions: ["accounts.view", "offers.manage"] }));

    const response = await app.request("/session", { headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { actor: ResolvedActor };
    expect(body.actor.permissions).toContain("accounts.view");
    expect(body.actor.permissions).not.toContain("offers.manage");
  });

  it("fails closed when the pre-wait actor exists but the request carries no session credential", async () => {
    const services = createServices({ dbRows: [SESSION_TOKEN_ROW] });
    const app = buildApp(services, createAccountUserTestActor());

    const response = await app.request("/session");

    expect(response.status).toBe(401);
  });

  it("fails closed instead of returning the cached pre-wait actor when the session token has expired", async () => {
    const services = createServices({
      dbRows: [{ ...SESSION_TOKEN_ROW, expires_at: new Date(Date.now() - 1_000).toISOString() }],
    });
    const app = buildApp(services, createAccountUserTestActor());

    const response = await app.request("/session", { headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(401);
    expect(services.identity.getUser).not.toHaveBeenCalled();
  });

  it("fails closed instead of returning the cached pre-wait actor when the session has been revoked", async () => {
    const services = createServices({
      dbRows: [SESSION_TOKEN_ROW],
      authenticatedSession: createAuthenticatedSession("revoked"),
    });
    const app = buildApp(services, createAccountUserTestActor());

    const response = await app.request("/session", { headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(401);
    expect(services.identity.getActiveMembershipForUserAccount).not.toHaveBeenCalled();
  });

  it("fails closed instead of returning the cached pre-wait actor when the session aggregate has elapsed", async () => {
    const services = createServices({
      dbRows: [SESSION_TOKEN_ROW],
      authenticatedSession: createAuthenticatedSession("active", new Date(Date.now() - 1_000).toISOString()),
    });
    const app = buildApp(services, createAccountUserTestActor());

    const response = await app.request("/session", { headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(401);
  });

  it("fails closed instead of returning the cached pre-wait actor when no active membership remains", async () => {
    const services = createServices({ dbRows: [SESSION_TOKEN_ROW], membership: null });
    const app = buildApp(services, createAccountUserTestActor());

    const response = await app.request("/session", { headers: { cookie: SESSION_COOKIE } });

    expect(response.status).toBe(401);
    expect(services.identity.getActiveMembershipForUserAccount).toHaveBeenCalledWith("usr_test", "acc_test");
    expect(services.identity.getUser).not.toHaveBeenCalled();
  });

  it("keeps the scope-attenuated linked-platform actor instead of substituting role permissions", async () => {
    // Fresh session resolution would succeed here and yield the full owner role,
    // so returning anything other than the host-resolved linked actor would widen
    // the OAuth grant to role-based permissions.
    const services = createServices({ dbRows: [SESSION_TOKEN_ROW] });
    const linkedActor: ResolvedActor = {
      sessionId: "ucp:auth_1",
      tenantId: "tnt_identity",
      userId: "usr_test",
      accountId: "acc_test",
      membershipId: "mbr_fresh",
      roleKey: "owner",
      permissions: ["offers.view"],
      agentGrant: { grantId: "auth_1", scopes: ["catalog:read"], rolePermissions: ["offers.view", "offers.manage"] },
    };
    const app = buildApp(services, linkedActor);

    const response = await app.request("/session", {
      headers: { authorization: "Bearer ucp_at_token", cookie: SESSION_COOKIE },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ actor: linkedActor });
    expect(services.db.query).not.toHaveBeenCalled();
    expect(services.identity.getUser).not.toHaveBeenCalled();
  });

  it("resolves the guest checkout actor from its own credential", async () => {
    const services = createServices({ dbRows: [GUEST_TOKEN_ROW] });
    const app = buildApp(services, createAccountUserTestActor({ permissions: ["accounts.view"] }));

    const response = await app.request("/session", { headers: { cookie: GUEST_COOKIE } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      actor: {
        sessionId: "guest:tok_guest",
        tenantId: "tnt_identity",
        userId: "usr_guest_checkout",
        accountId: "acc_guest",
        membershipId: "guest:tok_guest",
        roleKey: "guest-buyer",
        permissions: ["guest-checkout.manage"],
      },
    });
    expect(services.identity.getUser).not.toHaveBeenCalled();
  });

  it("requires authentication to sign out", async () => {
    const services = createServices();
    const app = buildApp(services, createAnonymousTestActor());

    const response = await app.request("/sign-out", { method: "POST" });

    expect(response.status).toBe(401);
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("revokes the caller's own session on sign-out", async () => {
    const services = createServices();
    const actor = createAccountUserTestActor({ sessionId: "ses_owner" });
    const app = buildApp(services, actor);

    const response = await app.request("/sign-out", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "ses_owner",
      version: 2,
      status: "revoked",
    });
    expect(services.sessions.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "RevokeSession" },
      }),
    );
  });

  it("denies listing sessions without the security.manage permission", async () => {
    const listSessions = vi.fn(async () => ({ items: [], total: 0 }));
    const services = createServices({ listSessions });
    const actor = createAccountUserTestActor({ permissions: ["accounts.view"] });
    const app = buildApp(services, actor);

    const response = await app.request("/sessions");

    expect(response.status).toBe(403);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("denies reading a single session without the security.manage permission", async () => {
    const services = createServices();
    const actor = createAccountUserTestActor({ permissions: ["accounts.view"] });
    const app = buildApp(services, actor);

    const response = await app.request("/sessions/ses_1");

    expect(response.status).toBe(403);
  });

  it("denies anonymous access to /sessions before any permission check", async () => {
    const listSessions = vi.fn(async () => ({ items: [], total: 0 }));
    const services = createServices({ listSessions });
    const app = buildApp(services, createAnonymousTestActor());

    const response = await app.request("/sessions");

    expect(response.status).toBe(401);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("allows security.manage actors to list sessions", async () => {
    const listSessions = vi.fn(async () => ({ items: [{ session_id: "ses_1" }], total: 1 }));
    const services = createServices({ listSessions });
    const actor = createAdminTestActor();
    const app = buildApp(services, actor);

    const response = await app.request("/sessions");

    expect(response.status).toBe(200);
    expect(listSessions).toHaveBeenCalled();
  });
});
