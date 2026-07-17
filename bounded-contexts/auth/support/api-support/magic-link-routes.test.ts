import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV } from "@chase-sets/platform-runtime/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServices, RegistrationAdmissionHostConfig } from "../runtime-support/services";
import type { AuthIdentityInvitationRow } from "../auth-support/identity-projection";
import { registerMagicLinkRoutes } from "./magic-link-routes";
import type { AuthApiEnv } from "./support";

const {
  mockConsumeMagicLinkToken,
  mockCreateIdentityAuthRequestClient,
  mockInsertMagicLinkToken,
  mockStartInteractiveAuth,
} = vi.hoisted(() => ({
  mockConsumeMagicLinkToken: vi.fn(),
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockInsertMagicLinkToken: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
}));

vi.mock("../auth-support/store", () => ({
  consumeMagicLinkToken: mockConsumeMagicLinkToken,
  insertMagicLinkToken: mockInsertMagicLinkToken,
}));

vi.mock("../runtime-support/services", () => ({
  startInteractiveAuth: mockStartInteractiveAuth,
}));

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

function buildApp(services: unknown) {
  return createTestApp<AuthApiEnv>({
    actor: createAnonymousTestActor(),
    context: createTestEventStoreContext(
      createInternalSystemTestActor({
        userId: "usr_test",
        accountId: "acc_test",
      }),
      {
        tenantId: "ten_test",
        trace: {},
      },
    ),
    routes: (app) => {
      registerMagicLinkRoutes(app, services as AuthServices);
    },
  });
}

function createServices() {
  const registrationAdmission: RegistrationAdmissionHostConfig = {
    mode: "open",
    disposableEmailMode: "enforce",
    disposableEmailDomains: ["mailinator.com"],
  };

  return {
    db: {
      query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })),
    },
    eventStore: {
      appendToStream: vi.fn(async () => ({ version: 1 })),
    },
    auth: {
      issueOpaqueToken: vi.fn(() => "magic_token"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUser: vi.fn(async (): Promise<{ user_id: string } | null> => ({ user_id: "usr_existing" })),
      getUserByEmail: vi.fn(async (): Promise<{ user_id: string } | null> => ({ user_id: "usr_existing" })),
      findPendingInvitationByEmail: vi.fn(async (_email: string): Promise<AuthIdentityInvitationRow | null> => null),
    },
    registrationAdmission,
  };
}

useMockReset();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("magic link auth routes", () => {
  it("requests a magic link without returning the bearer token to the browser", async () => {
    vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
    const services = createServices();
    const app = buildApp(services);

    const response = await app.request("http://internal-app/magic-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-host": "marketplace.chasesets.com",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        email: " Todd.Skelton@ChaseSets.com ",
        landingPath: "/sign-in/magic",
        returnTo: "/account/listings",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      tokenId: expect.stringMatching(/^cmd_/),
      expiresAt: expect.any(String),
    });
    expect(body).not.toHaveProperty("token");
    expect(mockInsertMagicLinkToken).toHaveBeenCalledWith(
      services.db,
      expect.objectContaining({
        userId: "usr_existing",
        email: "todd.skelton@chasesets.com",
        tokenHash: "hashed:magic_token",
        deliveryToken: "magic_token",
      }),
    );
    expect(services.eventStore.appendToStream).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            eventType: "auth.magic-link.requested",
            payload: expect.not.objectContaining({
              token: expect.anything(),
              deliveryToken: expect.anything(),
              tokenHash: expect.anything(),
            }),
          }),
        ],
      }),
    );
    expect(services.eventStore.appendToStream).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            payload: expect.objectContaining({
              origin: "https://marketplace.chasesets.com",
              landingPath: "/sign-in/magic",
              returnTo: "/account/listings",
            }),
          }),
        ],
      }),
    );
  });

  it("rate limits repeated magic link requests for one identifier", async () => {
    const services = createServices();
    const app = buildApp(services);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await app.request("http://internal-app/magic-link/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.44",
        },
        body: JSON.stringify({
          email: "limited-magic@example.test",
          landingPath: "/sign-in/magic",
        }),
      });
      expect(response.status).toBe(200);
    }

    const limited = await app.request("http://internal-app/magic-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.44",
      },
      body: JSON.stringify({
        email: "limited-magic@example.test",
        landingPath: "/sign-in/magic",
      }),
    });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    await expect(limited.json()).resolves.toMatchObject({
      error: {
        code: "rate_limited",
        surface: "auth.magic-link.request.identifier",
      },
    });
  });

  it("still consumes a valid email-delivered magic link token", async () => {
    const services = createServices();
    mockConsumeMagicLinkToken.mockResolvedValue({
      token_id: "cmd_magic",
      user_id: "usr_existing",
      email: "todd.skelton@chasesets.com",
      token_hash: "hashed:magic_token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    const verifyEmailContactMethod = vi.fn(async () => ({ ok: true, userId: "usr_existing", snapshots: [] }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      verifyEmailContactMethod,
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_existing",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "magic_token" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
    });
    expect(mockConsumeMagicLinkToken).toHaveBeenCalledWith(services.db, "hashed:magic_token");
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: "usr_existing",
        authenticationMethod: "magic-link",
      }),
    );
    expect(verifyEmailContactMethod).toHaveBeenCalledWith({
      userId: "usr_existing",
      email: "todd.skelton@chasesets.com",
    });
  });

  it("grants founders cohort access to a wave-admitted magic-link registration", async () => {
    const services = createServices();
    services.identity.getUser.mockResolvedValue(null);
    services.identity.getUserByEmail.mockResolvedValue(null);
    services.registrationAdmission = {
      mode: "invitation",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
      findAdmittedWaitlistSignupByEmail: vi.fn(async () => ({
        signup_id: "wls_wave",
        beta_invitation_id: "wvi_1_wave",
        admitted_wave: 1,
      })),
    };
    mockConsumeMagicLinkToken.mockResolvedValue({
      token_id: "cmd_wave",
      user_id: null,
      email: "wave@chasesets.test",
      token_hash: "hashed:magic_token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    const createPersonalIdentity = vi.fn(async () => ({
      userId: "usr_wave",
      accountId: "acc_wave",
      membershipId: "mbr_wave",
    }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity,
      verifyEmailContactMethod: vi.fn(async () => ({ ok: true, userId: "usr_wave", snapshots: [] })),
    });
    mockStartInteractiveAuth.mockResolvedValue({ type: "session-started", sessionToken: "session_token" });

    const response = await buildApp(services).request("/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "magic_token" }),
    });

    expect(response.status).toBe(200);
    expect(services.identity.findPendingInvitationByEmail).not.toHaveBeenCalled();
    expect(createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ email: "wave@chasesets.test", foundersBetaAccessStartedAt: expect.any(String) }),
    );
  });

  it("does not grant founders cohort access to a team-invited magic-link registration", async () => {
    const services = createServices();
    services.identity.getUser.mockResolvedValue(null);
    services.identity.getUserByEmail.mockResolvedValue(null);
    services.registrationAdmission = {
      mode: "invitation",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
    };
    services.identity.findPendingInvitationByEmail.mockResolvedValue({
      invitation_id: "ivt_support_1",
      account_id: "acc_support",
      email: "support-invite@chasesets.test",
      role_key: "owner",
      status: "pending",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      accepted_by_user_id: null,
      invited_by_user_id: "usr_support",
      updated_at: new Date().toISOString(),
    });
    mockConsumeMagicLinkToken.mockResolvedValue({
      token_id: "cmd_support",
      user_id: null,
      email: "support-invite@chasesets.test",
      token_hash: "hashed:magic_token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    const createPersonalIdentity = vi.fn(async () => ({
      userId: "usr_support_invite",
      accountId: "acc_support_invite",
      membershipId: "mbr_support_invite",
    }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity,
      verifyEmailContactMethod: vi.fn(async () => ({ ok: true, userId: "usr_support_invite", snapshots: [] })),
    });
    mockStartInteractiveAuth.mockResolvedValue({ type: "session-started", sessionToken: "session_token" });

    const response = await buildApp(services).request("/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "magic_token" }),
    });

    expect(response.status).toBe(200);
    expect(createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "support-invite@chasesets.test",
        foundersBetaAccessStartedAt: undefined,
      }),
    );
  });

  it("rejects invalid, expired, or already consumed magic link tokens", async () => {
    const services = createServices();
    mockConsumeMagicLinkToken.mockResolvedValue(null);
    const app = buildApp(services);

    const response = await app.request("/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "expired_token" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Magic link is invalid or has expired.",
    });
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });
});
