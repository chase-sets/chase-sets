import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { registerPasswordRoutes } from "./password-routes";
import type { AuthApiEnv } from "./support";

const { mockGetPasswordCredentialByUserId, mockStartInteractiveAuth } = vi.hoisted(() => ({
  mockGetPasswordCredentialByUserId: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
}));

vi.mock("../auth-support/store", () => ({
  getPasswordCredentialByUserId: mockGetPasswordCredentialByUserId,
}));

vi.mock("../runtime-support/services", () => ({
  startInteractiveAuth: mockStartInteractiveAuth,
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
      registerPasswordRoutes(app, services as AuthServices);
    },
  });
}

function createServices() {
  return {
    db: {
      query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })),
    },
    auth: {
      verifySecret: vi.fn(() => true),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserByEmail: vi.fn(async () => ({ user_id: "usr_existing" }) as { user_id: string } | null),
    },
  };
}

function signInRequest(app: ReturnType<typeof buildApp>, body: unknown, forwardedFor: string) {
  return app.request("/password-sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify(body),
  });
}

useMockReset(mockGetPasswordCredentialByUserId, mockStartInteractiveAuth);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("password auth routes", () => {
  it("signs in with a matching email and password", async () => {
    const services = createServices();
    mockGetPasswordCredentialByUserId.mockResolvedValue({
      credential_id: "pwd_1",
      user_id: "usr_existing",
      secret_hash: "hash_correct",
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

    const response = await signInRequest(
      app,
      { email: "Buyer@Example.com", password: "correct-horse" },
      "203.0.113.60",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
    });
    expect(services.identity.getUserByEmail).toHaveBeenCalledWith("buyer@example.com");
    expect(mockGetPasswordCredentialByUserId).toHaveBeenCalledWith(services.db, "usr_existing");
    expect(services.auth.verifySecret).toHaveBeenCalledWith("correct-horse", "hash_correct");
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: "usr_existing",
        authenticationMethod: "password",
      }),
    );
  });

  it("rejects sign-in for an email with no account, without starting a session", async () => {
    const services = createServices();
    services.identity.getUserByEmail = vi.fn(async () => null);
    const app = buildApp(services);

    const response = await signInRequest(app, { email: "nobody@example.com", password: "whatever" }, "203.0.113.61");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid email or password." });
    expect(mockGetPasswordCredentialByUserId).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("rejects sign-in for a wrong password with the same generic error, without starting a session", async () => {
    const services = createServices();
    mockGetPasswordCredentialByUserId.mockResolvedValue({
      credential_id: "pwd_1",
      user_id: "usr_existing",
      secret_hash: "hash_correct",
    });
    services.auth.verifySecret = vi.fn(() => false);
    const app = buildApp(services);

    const response = await signInRequest(app, { email: "buyer@example.com", password: "wrong" }, "203.0.113.62");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid email or password." });
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("rejects sign-in when the user has no password credential on file", async () => {
    const services = createServices();
    mockGetPasswordCredentialByUserId.mockResolvedValue(null);
    const app = buildApp(services);

    const response = await signInRequest(app, { email: "buyer@example.com", password: "whatever" }, "203.0.113.63");

    expect(response.status).toBe(401);
    expect(services.auth.verifySecret).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("rate limits failed password verification per identifier and per IP", async () => {
    const services = createServices();
    services.identity.getUserByEmail = vi.fn(async () => null);
    const app = buildApp(services);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await signInRequest(
        app,
        { email: "locked@example.test", password: "wrong" },
        `203.0.113.${90 + attempt}`,
      );
      expect(response.status).toBe(401);
    }

    const identifierLimited = await signInRequest(
      app,
      { email: "locked@example.test", password: "wrong" },
      "203.0.113.96",
    );
    expect(identifierLimited.status).toBe(429);
    await expect(identifierLimited.json()).resolves.toMatchObject({
      error: { code: "rate_limited", surface: "auth.sign-in.identifier-failures" },
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await signInRequest(
        app,
        { email: `unknown-${attempt}@example.test`, password: "wrong" },
        "203.0.113.100",
      );
      expect(response.status).toBe(401);
    }

    const ipLimited = await signInRequest(app, { email: "unknown-6@example.test", password: "wrong" }, "203.0.113.100");
    expect(ipLimited.status).toBe(429);
    await expect(ipLimited.json()).resolves.toMatchObject({
      error: { code: "rate_limited", surface: "auth.sign-in.ip-failures" },
    });
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });
});
