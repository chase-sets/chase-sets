import {
  createAccountUserTestActor,
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV } from "@chase-sets/platform-runtime/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthServicesFake } from "../auth-support/test-support";
import type { AuthServices } from "../runtime-support/services";
import { registerSocialLoginRoutes } from "./social-login-routes";
import type { AuthApiEnv } from "./support";

const { mockCreateIdentityAuthRequestClient, mockIdentityMutations } = vi.hoisted(() => ({
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockIdentityMutations: {
    createPersonalIdentity: vi.fn(),
    linkSocialLogin: vi.fn(),
    verifyEmailContactMethod: vi.fn(),
  },
}));

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

function buildApp(
  services: AuthServices,
  actor: ReturnType<typeof createAccountUserTestActor> | null = createAnonymousTestActor(),
) {
  return createTestApp<AuthApiEnv>({
    actor,
    context: createTestEventStoreContext(createInternalSystemTestActor(), {
      tenantId: "ten_test",
      trace: {},
    }),
    routes: (app) => {
      registerSocialLoginRoutes(app, services);
    },
  });
}

function createServices(
  options: Readonly<{
    profile?: {
      email: string | null;
      emailVerified: boolean;
      hostedDomain?: string | null;
    };
    providerName?: "google" | "facebook";
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
  }>,
) {
  const states = new Map<
    string,
    {
      state_hash: string;
      provider_name: string;
      journey: string;
      return_to: string;
      expires_at: string;
      consumed_at: string | null;
    }
  >();
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

  return createAuthServicesFake({
    db,
    session: {
      session_id: "ses_social",
      user_id: "usr_existing",
      account_id: "acc_existing",
      available_account_ids: ["acc_existing"],
      authentication_method: "google",
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserBySocialLogin: vi.fn(async () => options.socialLoginUser ?? null),
      getUserByEmail: vi.fn(async () => options.existingUser ?? null),
      findPendingInvitationByEmail: vi.fn(async () => null),
      getUser: vi.fn(async (userId: string) => ({
        user_id: userId,
        status: "active",
      })),
      listActiveMembershipsForUser: vi.fn(
        async () =>
          options.memberships ?? [
            {
              membershipId: "mbr_existing",
              accountId: "acc_existing",
              roleKey: "owner",
              status: "active",
              rolePermissions: [],
            },
          ],
      ),
    },
    socialLoginProviders: [
      {
        providerName: options.providerName ?? "google",
        createAuthorizationUrl: vi.fn(({ state }) => `https://provider.test/auth?state=${encodeURIComponent(state)}`),
        exchangeCallback: vi.fn(async () => {
          if (options.providerFails) {
            throw new Error("provider failed");
          }

          return {
            providerName: options.providerName ?? "google",
            providerSubject: `${options.providerName ?? "google"}-subject`,
            email: options.profile ? options.profile.email : "buyer@example.com",
            emailVerified: options.profile?.emailVerified ?? true,
            hostedDomain: options.profile?.hostedDomain,
            displayName: "Buyer Example",
          };
        }),
      },
    ],
    adminGoogleWorkspaceSso: {
      allowedHostedDomains: ["chasesets.com"],
    },
  });
}

useMockReset(
  mockCreateIdentityAuthRequestClient,
  mockIdentityMutations.createPersonalIdentity,
  mockIdentityMutations.linkSocialLogin,
  mockIdentityMutations.verifyEmailContactMethod,
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("social login routes", () => {
  it("starts a provider redirect with a single-use state token", async () => {
    const services = createServices({ existingUser: null });
    const app = buildApp(services);

    const response = await app.request("/social/google/start?journey=registration&returnTo=/account/orders");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://provider.test/auth?state=social_token");
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_social_login_states"),
      expect.arrayContaining([
        "hashed:social_token",
        "google",
        "registration",
        "/account/orders?__registrationConsentAffirmed=false",
      ]),
    );
  });

  it("requires an authenticated user before starting an account-link journey", async () => {
    const services = createServices({ existingUser: null, providerName: "facebook" });
    const app = buildApp(services);

    const response = await app.request("/social/facebook/start?journey=link&returnTo=/account");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/sign-in?socialLoginError=");
    expect(services.socialLoginProviders[0]!.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("uses the forwarded HTTPS origin for provider callback redirects", async () => {
    vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
    const services = createServices({ existingUser: null });
    const app = buildApp(services);

    const response = await app.request("http://internal-app/social/google/start?returnTo=/account", {
      headers: {
        "x-forwarded-host": "admin.staging.chasesets.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(302);
    expect(services.socialLoginProviders[0]!.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://admin.staging.chasesets.com/api/auth/social/google/callback",
      }),
    );
  });

  it("keeps local development callback redirects on HTTP", async () => {
    const services = createServices({ existingUser: null });
    const app = buildApp(services);

    await app.request("http://localhost:3000/social/google/start?returnTo=/account");

    expect(services.socialLoginProviders[0]!.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "http://localhost:3000/api/auth/social/google/callback",
      }),
    );
  });

  it("links an existing verified-email user and starts a session", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?returnTo=/account");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(mockIdentityMutations.linkSocialLogin).toHaveBeenCalledWith({
      userId: "usr_existing",
      providerName: "google",
      providerSubject: "google-subject",
      email: "buyer@example.com",
    });
    expect(mockIdentityMutations.createPersonalIdentity).not.toHaveBeenCalled();
  });

  it("uses the forwarded HTTPS origin when exchanging provider callbacks", async () => {
    vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("http://internal-app/social/google/start?returnTo=/account", {
      headers: {
        "x-forwarded-host": "admin.staging.chasesets.com",
        "x-forwarded-proto": "https",
      },
    });
    const response = await app.request(
      "http://internal-app/social/google/callback?state=social_token&code=provider-code",
      {
        headers: {
          "x-forwarded-host": "admin.staging.chasesets.com",
          "x-forwarded-proto": "https",
        },
      },
    );

    expect(response.status).toBe(302);
    expect(services.socialLoginProviders[0]!.exchangeCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://admin.staging.chasesets.com/api/auth/social/google/callback",
      }),
    );
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
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    const fallback = new URL(response.headers.get("Location")!, "https://market.test");
    expect(fallback.pathname).toBe("/sign-in");
    expect(fallback.searchParams.get("socialLoginError")).toBeTruthy();
    expect(fallback.searchParams.get("returnTo")).toBeNull();
    expect(mockIdentityMutations.linkSocialLogin).not.toHaveBeenCalled();
    expect(mockIdentityMutations.createPersonalIdentity).not.toHaveBeenCalled();
  });

  it("does not resolve or link an existing user by an unverified provider email", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      providerName: "facebook",
      profile: {
        email: "buyer@example.com",
        emailVerified: false,
      },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/facebook/start");
    const response = await app.request("/social/facebook/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    const fallback = new URL(response.headers.get("Location")!, "https://market.test");
    expect(fallback.pathname).toBe("/sign-in");
    expect(fallback.searchParams.get("socialLoginError")).toBeTruthy();
    expect(fallback.searchParams.get("returnTo")).toBe(
      "/api/auth/social/facebook/start?journey=link&returnTo=%2Faccount",
    );
    expect(services.identity.getUserByEmail).not.toHaveBeenCalled();
    expect(mockIdentityMutations.linkSocialLogin).not.toHaveBeenCalled();
    expect(mockIdentityMutations.verifyEmailContactMethod).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("authenticates an existing provider-subject link without relinking an unverified email", async () => {
    const services = createServices({
      existingUser: null,
      providerName: "facebook",
      socialLoginUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "buyer@example.com",
        emailVerified: false,
      },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/facebook/start?returnTo=/account");
    const response = await app.request("/social/facebook/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(services.identity.getUserByEmail).not.toHaveBeenCalled();
    expect(mockIdentityMutations.linkSocialLogin).not.toHaveBeenCalled();
    expect(mockIdentityMutations.verifyEmailContactMethod).not.toHaveBeenCalled();
  });

  it("links an unverified provider subject only to the authenticated user", async () => {
    const services = createServices({
      existingUser: null,
      providerName: "facebook",
      profile: {
        email: "buyer@example.com",
        emailVerified: false,
      },
    });
    const actor = createAccountUserTestActor({ userId: "usr_authenticated" });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services, actor);

    await app.request("/social/facebook/start?journey=link&returnTo=/account");
    const response = await app.request("/social/facebook/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account");
    expect(services.identity.getUserByEmail).not.toHaveBeenCalled();
    expect(mockIdentityMutations.linkSocialLogin).toHaveBeenCalledWith({
      userId: "usr_authenticated",
      providerName: "facebook",
      providerSubject: "facebook-subject",
      email: "buyer@example.com",
    });
    expect(mockIdentityMutations.verifyEmailContactMethod).not.toHaveBeenCalled();
  });

  it("does not move an existing provider-subject link to another authenticated user", async () => {
    const services = createServices({
      existingUser: null,
      providerName: "facebook",
      socialLoginUser: { user_id: "usr_link_owner", status: "active" },
      profile: {
        email: "buyer@example.com",
        emailVerified: false,
      },
    });
    const actor = createAccountUserTestActor({ userId: "usr_authenticated" });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services, actor);

    await app.request("/social/facebook/start?journey=link&returnTo=/account");
    const response = await app.request("/social/facebook/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/sign-in?socialLoginError=");
    expect(mockIdentityMutations.linkSocialLogin).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
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

    await app.request("/social/google/start?journey=registration&consentAffirmed=true&returnTo=/account");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account");
    expect(mockIdentityMutations.createPersonalIdentity).toHaveBeenCalledWith({
      email: "buyer@example.com",
      displayName: "Buyer Example",
      givenName: undefined,
      familyName: undefined,
      consentAffirmed: true,
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
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/select?returnTo=%2Faccount%2Forders");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_account_selection=acct_token");
  });

  it("returns to the registration fallback when provider exchange fails during registration", async () => {
    const services = createServices({
      existingUser: null,
      providerFails: true,
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=registration");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

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
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/sign-in?socialLoginError=");
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("starts admin Google Workspace SSO with a hosted-domain hint", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
    });
    const app = buildApp(services);

    const response = await app.request("/social/google/start?journey=admin&returnTo=/access/accounts");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://provider.test/auth?state=social_token");
    expect(services.socialLoginProviders[0]!.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        hostedDomain: "chasesets.com",
      }),
    );
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_social_login_states"),
      expect.arrayContaining(["hashed:social_token", "google", "admin", "/access/accounts"]),
    );
  });

  it("falls back to the admin success path when admin SSO returnTo is unsafe", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
    });
    const app = buildApp(services);

    const response = await app.request("/social/google/start?journey=admin&returnTo=//evil.example/access");

    expect(response.status).toBe(302);
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_social_login_states"),
      expect.arrayContaining(["hashed:social_token", "google", "admin", "/"]),
    );
  });

  it("rejects admin Google Workspace SSO when the hosted domain is not allowed", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/access/accounts");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/access/sign-in?socialLoginError=");
    expect(mockIdentityMutations.linkSocialLogin).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("does not create a personal identity during admin Google Workspace SSO", async () => {
    const services = createServices({
      existingUser: null,
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/access/accounts");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/access/sign-in?socialLoginError=");
    expect(mockIdentityMutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("filters admin account selection to memberships that can access the admin surface", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_admin",
          accountId: "acc_admin",
          roleKey: "platform-admin",
          status: "active",
          rolePermissions: ["accounts.view", "security.manage"],
        },
        {
          membershipId: "mbr_viewer",
          accountId: "acc_viewer",
          roleKey: "viewer",
          status: "active",
          rolePermissions: ["accounts.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/access/accounts");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/access/account-select?returnTo=%2Faccess%2Faccounts");
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("filters admin SSO memberships by the requested Support route permission", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_support_feedback",
          accountId: "acc_support_feedback",
          roleKey: "support-feedback",
          status: "active",
          rolePermissions: ["platform-feedback.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/support/platform-feedback");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/support/platform-feedback");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(services.sessions.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          accountId: "acc_support_feedback",
          availableAccountIds: ["acc_support_feedback"],
        }),
      }),
    );
  });

  it("filters admin SSO memberships by the requested Growth route permission", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_public_presence",
          accountId: "acc_public_presence",
          roleKey: "growth-public-presence",
          status: "active",
          rolePermissions: ["public-presence.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/growth/waitlist");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/growth/waitlist");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
  });

  it("filters admin SSO memberships by the requested Commerce route permission", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_commercial_terms",
          accountId: "acc_commercial_terms",
          roleKey: "commercial-terms-admin",
          status: "active",
          rolePermissions: ["commercial-terms.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/commerce/terms/schedules");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/commerce/terms/schedules");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
  });

  it("allows admin SSO section roots for actors with any visible route permission", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_postage",
          accountId: "acc_postage",
          roleKey: "postage-policy-admin",
          status: "active",
          rolePermissions: ["postage-policies.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/commerce");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/commerce");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
  });

  it("filters admin SSO Platform entry by projection operations permission", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_projection_ops",
          accountId: "acc_projection_ops",
          roleKey: "projection-operations-admin",
          status: "active",
          rolePermissions: ["projection-operations.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/platform/projections");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/platform/projections");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(services.sessions.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          accountId: "acc_projection_ops",
          availableAccountIds: ["acc_projection_ops"],
        }),
      }),
    );
  });

  it("rejects admin SSO Platform entry for security-only Access actors", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_security",
          accountId: "acc_security",
          roleKey: "access-security-admin",
          status: "active",
          rolePermissions: ["security.manage"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/platform");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/access/sign-in?socialLoginError=");
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("allows admin SSO root entry for catalog-only actors", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_catalog",
          accountId: "acc_catalog",
          roleKey: "catalog-admin",
          status: "active",
          rolePermissions: ["catalog.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
  });

  it("rejects admin SSO when memberships do not match the requested route permission", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
      profile: {
        email: "operator@chasesets.com",
        emailVerified: true,
        hostedDomain: "chasesets.com",
      },
      memberships: [
        {
          membershipId: "mbr_accounts",
          accountId: "acc_accounts",
          roleKey: "access-viewer",
          status: "active",
          rolePermissions: ["accounts.view"],
        },
      ],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?journey=admin&returnTo=/support/platform-feedback");
    const response = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/access/sign-in?socialLoginError=");
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects a second callback that replays an already-consumed social login state", async () => {
    const services = createServices({
      existingUser: { user_id: "usr_existing", status: "active" },
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(mockIdentityMutations);
    const app = buildApp(services);

    await app.request("/social/google/start?returnTo=/account");
    const first = await app.request("/social/google/callback?state=social_token&code=provider-code");
    const replay = await app.request("/social/google/callback?state=social_token&code=provider-code");

    expect(first.status).toBe(302);
    expect(first.headers.get("Location")).toBe("/account");
    expect(replay.status).toBe(302);
    expect(replay.headers.get("Location")).toContain("/sign-in?socialLoginError=");
    expect(services.sessions.commandHandler).toHaveBeenCalledTimes(1);
  });
});
