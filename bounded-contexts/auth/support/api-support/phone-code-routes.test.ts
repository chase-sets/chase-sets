import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { registerPhoneCodeRoutes } from "./phone-code-routes";
import type { AuthApiEnv } from "./support";

const { mockCreateIdentityAuthRequestClient, mockCreatePersonalIdentity, mockStartInteractiveAuth } = vi.hoisted(
  () => ({
    mockCreateIdentityAuthRequestClient: vi.fn(),
    mockCreatePersonalIdentity: vi.fn(),
    mockStartInteractiveAuth: vi.fn(),
  }),
);

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

vi.mock("../runtime-support/services", async () => {
  const actual = await vi.importActual<typeof import("../runtime-support/services")>("../runtime-support/services");

  return {
    ...actual,
    startInteractiveAuth: mockStartInteractiveAuth,
  };
});

function buildApp(services: unknown) {
  return createTestApp<AuthApiEnv>({
    actor: createAnonymousTestActor(),
    context: createTestEventStoreContext(
      createInternalSystemTestActor({
        userId: "usr_test",
        accountId: "acc_test",
      }),
      {
        tenantId: "tnt_test",
        trace: { traceId: "trc_test" as never },
      },
    ),
    routes: (app) => {
      registerPhoneCodeRoutes(app, services as AuthServices);
    },
  });
}

useMockReset(mockCreateIdentityAuthRequestClient, mockCreatePersonalIdentity, mockStartInteractiveAuth);

describe("phone code auth routes", () => {
  it("normalizes phone numbers and enqueues an SMS security notification", async () => {
    const enqueueNotification = vi.fn(async () => undefined);
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const services = {
      db: { query },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => null),
      },
      registrationAdmission: {
        mode: "open",
        disposableEmailMode: "enforce",
        disposableEmailDomains: ["mailinator.com"],
      },
      notificationOutbox: { enqueueNotification },
    };
    const app = buildApp(services);

    const response = await app.request("/phone-code/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "(312) 555-0101" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        phone: "+13125550101",
        tokenId: expect.stringMatching(/^cmd_/),
        expiresAt: expect.any(String),
      }),
    );
    expect(body.code).toBeUndefined();
    expect(services.identity.getUserByPhone).toHaveBeenCalledWith("+13125550101");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_phone_code_tokens"),
      expect.arrayContaining(["+13125550101"]),
    );
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "auth.phone-code.requested",
          criticality: "security",
          channels: [
            expect.objectContaining({
              channel: "sms",
              to: { e164: "+13125550101" },
            }),
          ],
        }),
      }),
    );
  });

  it("rejects invalid or expired codes without starting a session", async () => {
    const services = {
      db: { query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })) },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => null),
        listActiveMembershipsForUser: vi.fn(async () => []),
      },
      registrationAdmission: {
        mode: "open",
        disposableEmailMode: "enforce",
        disposableEmailDomains: ["mailinator.com"],
      },
      notificationOutbox: { enqueueNotification: vi.fn() },
    };
    const app = buildApp(services);

    const response = await app.request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "3125550101", code: "123456" }),
    });

    expect(response.status).toBe(401);
    expect(services.auth.hashSecret).toHaveBeenCalledWith("+13125550101:123456");
    expect(services.identity.listActiveMembershipsForUser).not.toHaveBeenCalled();
  });

  it("normalizes whitespace and dashes before consuming phone codes", async () => {
    const services = {
      db: { query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })) },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => null),
        listActiveMembershipsForUser: vi.fn(async () => []),
      },
      registrationAdmission: {
        mode: "open",
        disposableEmailMode: "enforce",
        disposableEmailDomains: ["mailinator.com"],
      },
      notificationOutbox: { enqueueNotification: vi.fn() },
    };
    const app = buildApp(services);

    const response = await app.request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "3125550101", code: "123 456- " }),
    });

    expect(response.status).toBe(401);
    expect(services.auth.hashSecret).toHaveBeenCalledWith("+13125550101:123456");
    expect(services.identity.listActiveMembershipsForUser).not.toHaveBeenCalled();
  });

  it("consumes a valid phone code and creates a new identity when no user exists yet", async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("UPDATE identity_phone_code_tokens")) {
        return {
          rows: [
            {
              token_id: "cmd_phone_1",
              user_id: null,
              phone: "+13125550101",
              code_hash: String(params[1]),
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              consumed_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const services = {
      db: { query },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => null),
      },
      registrationAdmission: {
        mode: "open",
        disposableEmailMode: "enforce",
        disposableEmailDomains: ["mailinator.com"],
      },
      notificationOutbox: { enqueueNotification: vi.fn() },
    };
    mockCreatePersonalIdentity.mockResolvedValue({
      userId: "usr_new",
      accountId: "acc_new",
      membershipId: "mbr_new",
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({ createPersonalIdentity: mockCreatePersonalIdentity });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_new",
      sessionToken: "session_token",
      session: { session_id: "ses_new", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "3125550101", code: "123456", displayName: "New Buyer" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
    });
    expect(mockCreatePersonalIdentity).toHaveBeenCalledWith({
      phone: "+13125550101",
      displayName: "New Buyer",
    });
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: "usr_new",
        accountId: "acc_new",
        authenticationMethod: "sms-code",
        membershipsOverride: [
          expect.objectContaining({
            membershipId: "mbr_new",
            accountId: "acc_new",
            roleKey: "owner",
          }),
        ],
      }),
    );
  });

  it("rejects a second consume attempt against an already-redeemed phone code", async () => {
    let consumed = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE identity_phone_code_tokens") && !consumed) {
        consumed = true;
        return {
          rows: [
            {
              token_id: "cmd_phone_2",
              user_id: "usr_existing",
              phone: "+13125550101",
              code_hash: "hashed:+13125550101:654321",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              consumed_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const services = {
      db: { query },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => null),
        getUser: vi.fn(async () => ({ user_id: "usr_existing", auth_methods: ["sms-code"] })),
      },
      registrationAdmission: {
        mode: "open",
        disposableEmailMode: "enforce",
        disposableEmailDomains: ["mailinator.com"],
      },
      notificationOutbox: { enqueueNotification: vi.fn() },
    };
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_existing",
      sessionId: "ses_existing",
      sessionToken: "session_token",
      session: { session_id: "ses_existing", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);
    const requestBody = JSON.stringify({ phone: "3125550101", code: "654321" });

    const first = await app.request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
    const replay = await app.request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(mockStartInteractiveAuth).toHaveBeenCalledTimes(1);
  });
});
