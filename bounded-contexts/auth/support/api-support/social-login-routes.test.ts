import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { registerSocialLoginRoutes } from "./social-login-routes";
import type { AuthApiEnv } from "./support";

const { mockCreateIdentityAuthRequestClient, mockIdentityMutations } = vi.hoisted(
  () => ({
    mockCreateIdentityAuthRequestClient: vi.fn(),
    mockIdentityMutations: {
      createPersonalIdentity: vi.fn(),
      linkSocialLogin: vi.fn(),
    },
  }),
);

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

function buildApp(services: AuthServices) {
  const app = new Hono<AuthApiEnv>();
  app.use("*", async (c, next) => {
    c.set("context", {
      tenantId: "ten_test",
      audit: {
        performedByUserId: "usr_system",
        forAccountId: "acc_system",
      },
      trace: {},
    } as never);
    c.set("actor", null);
    await next();
  });
  registerSocialLoginRoutes(app, services);
  return app;
}

function createServices(options: Readonly<{
  profile?: {
    email: string | null;
    emailVerified: boolean;
  };
  providerFails?: boolean;
  existingUser?: { user_id: string; status: string } | null;
  socialLoginUser?: { user_id: string; status: string } | null;
  memberships?: readonly {
    membershipId: string;
    accountId: string;
    roleKey: string;
    status: string;
    rolePermissions: readonly string[];
  }[];
}>) {
  const states = new Map<string, {
    state_hash: string;
    provider_name: string;
    journey: string;
    return_to: string;
    expires_at: string;
    consumed_at: string | null;
  }>();
  const db = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO identity_social_login_states")) {
        states.set(String(params[0]), {
          state_hash: String(params[0]),
          provider_name: String(params[1]),
          journey: String(params[2]),
          return_to: String(params[3]),
          expires_at: String(params[4]),
          consumed_at: null,
        });
        return { rows: [] };
      }
      if (sql.includes("UPDATE identity_social_login_states")) {
        const state = states.get(String(params[0]));
        if (!state || state.provider_name !== params[1] || state.consumed_at) {
          return { rows: [] };
        }
        state.consumed_at = "2026-05-14T00:00:00.000Z";
        return { rows: [state] };
      }
      return { rows: [] };
    }),
  };
  const session = {
    session_id: "ses_social",
    user_id: "usr_existing",
    account_id: "acc_existing",
    available_account_ids: ["acc_existing"],
    authentication_method: "google",
    status: "active",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };

  return {
    db,
    auth: {
      issueOpaqueToken: vi.fn((prefix: string) => `${prefix}_token`),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserBySocialLogin: vi.fn(async () => options.socialLoginUser ?? null),
      getUserByEmail: vi.fn(async () => options.existingUser ?? null),
      getUser: vi.fn(async (userId: string) => ({
        user_id: userId,
        status: "active",
      })),
      listActiveMembershipsForUser: vi.fn(async () => options.memberships ?? [
        {
          membershipId: "mbr_existing",
          accountId: "acc_existing",
          roleKey: "owner",
          status: "active",
          rolePermissions: [],
        },
      ]),
    },
    sessions: {
      commandHandler: vi.fn(async () => ({
        version: 1,
        state: {},
      })),
      getSession: vi.fn(async () => session),
    },
    eventStore: {
      appendToStream: vi.fn(),
    },
    socialLoginProviders: [
      {
        providerName: "google",
        createAuthorizationUrl: vi.fn(({ state }) =>
          `https://provider.test/auth?state=${encodeURIComponent(state)}`,
        ),
        exchangeCallback: vi.fn(async () => {
          if (options.providerFails) {
            throw new Error("provider failed");
          }

          return {
            providerName: "google",
            providerSubject: "google-subject",
            email: options.profile?.email ?? "buyer@example.com",
            emailVerified: options.profile?.emailVerified ?? true,
            displayName: "Buyer Example",
          };
        }),
      },
    ],
    projectors: [],
  } as unknown as AuthServices;
}

afterEach(() => {
  mockCreateIdentityAuthRequestClient.mockReset();
  mockIdentityMutations.createPersonalIdentity.mockReset();
  mockIdentityMutations.linkSocialLogin.mockReset();
});

describe("social login routes", () => {
  it("starts a provider redirect with a single-use state token", async () => {
    const services = createServices({ existingUser: null });
    const app = buildApp(services);

    const response = await app.request(
      "/social/google/start?journey=registration&returnTo=/account/orders",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://provider.test/auth?state=social_token",
    );
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_social_login_states"),
      expect.arrayContaining([
        "hashed:social_token",
        "google",
        "registration",
        "/account/orders",
      ]),
    );
  });

  it("links an existing verified-email user and starts a session", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?returnTo=/account");
    const response = await app.request(
      "/social/google/callback?state=social_token&code=provider-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(mockIdentityMutations.linkSocialLogin).toHaveBeenCalledWith({
      userId: "usr_existing",
      providerName: "google",
      providerSubject: "google-subject",
      email: "buyer@example.com",
    });
    expect(mockIdentityMutations.createPersonalIdentity).not.toHaveBeenCalled();
  });

  it("returns to fallback when provider email is missing or unverified", async () => {
    const services = createServices({
      existingUser: null,
      profile: {
        email: null,
        emailVerified: false,
      },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start");
    const response = await app.request(
      "/social/google/callback?state=social_token&code=provider-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/sign-in?socialLoginError=");
    expect(mockIdentityMutations.linkSocialLogin).not.toHaveBeenCalled();
    expect(mockIdentityMutations.createPersonalIdentity).not.toHaveBeenCalled();
  });

  it("creates a personal identity for a verified provider profile without an existing user", async () => {
    const services = createServices({
      existingUser: null,
      memberships: [
        {
          membershipId: "mbr_new",
          accountId: "acc_new",
          roleKey: "owner",
          status: "active",
          rolePermissions: [],
        },
      ],
    });
    mockIdentityMutations.createPersonalIdentity.mockResolvedValue({
      userId: "usr_new",
      accountId: "acc_new",
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=registration&returnTo=/account");
    const response = await app.request(
      "/social/google/callback?state=social_token&code=provider-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account");
    expect(mockIdentityMutations.createPersonalIdentity).toHaveBeenCalledWith({
      email: "buyer@example.com",
      displayName: "Buyer Example",
      givenName: undefined,
      familyName: undefined,
    });
    expect(mockIdentityMutations.linkSocialLogin).toHaveBeenCalledWith({
      userId: "usr_new",
      providerName: "google",
      providerSubject: "google-subject",
      email: "buyer@example.com",
    });
  });

  it("continues through account selection when the social login user has multiple accounts", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      memberships: [
        {
          membershipId: "mbr_primary",
          accountId: "acc_primary",
          roleKey: "owner",
          status: "active",
          rolePermissions: [],
        },
        {
          membershipId: "mbr_secondary",
          accountId: "acc_secondary",
          roleKey: "buyer",
          status: "active",
          rolePermissions: [],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?returnTo=/account/orders");
    const response = await app.request(
      "/social/google/callback?state=social_token&code=provider-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/account/select?returnTo=%2Faccount%2Forders",
    );
    expect(response.headers.getSetCookie().join(";")).toContain(
      "chase_sets_account_selection=acct_token",
    );
  });

  it("returns to the registration fallback when provider exchange fails during registration", async () => {
    const services = createServices({
      existingUser: null,
      providerFails: true,
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=registration");
    const response = await app.request(
      "/social/google/callback?state=social_token&code=provider-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/register?socialLoginError=");
    expect(mockIdentityMutations.linkSocialLogin).not.toHaveBeenCalled();
    expect(mockIdentityMutations.createPersonalIdentity).not.toHaveBeenCalled();
  });

  it("returns to fallback when Identity rejects a duplicate provider link", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
    });
    mockIdentityMutations.linkSocialLogin.mockRejectedValue(
      Object.assign(new Error("already linked"), { status: 409 }),
    );
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start");
    const response = await app.request(
      "/social/google/callback?state=social_token&code=provider-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/sign-in?socialLoginError=");
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });
});
