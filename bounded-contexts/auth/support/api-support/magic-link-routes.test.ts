import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
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
      getUser: vi.fn(async () => ({ user_id: "usr_existing" })),
      getUserByEmail: vi.fn(async () => ({ user_id: "usr_existing" })),
    },
  };
}

useMockReset();

describe("magic link auth routes", () => {
  it("requests a magic link without returning the bearer token to the browser", async () => {
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
