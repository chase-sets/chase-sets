import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import {
  SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION,
  withRegistrationConsentResolution,
} from "./registration-consent-test-support";
import type { AuthServices } from "../runtime-support/services";
import { registerPhoneCodeRoutes } from "./phone-code-routes";
import type { AuthApiEnv } from "./support";
import { defineAuthHost } from "../route-support/auth-host";

const { mockCreateIdentityAuthRequestClient, mockCreatePersonalIdentity, mockStartInteractiveAuth } = vi.hoisted(
  () => ({
    mockCreateIdentityAuthRequestClient: vi.fn(),
    mockCreatePersonalIdentity: vi.fn(),
    mockStartInteractiveAuth: vi.fn(),
  }),
);

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");
  return {
    ...actual,
    createIdentityAuthRequestClient: (...args: readonly unknown[]) =>
      withRegistrationConsentResolution(mockCreateIdentityAuthRequestClient(...args) ?? {}),
  };
});

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
      app.onError(errorHandler);
    },
  });
}

useMockReset(mockCreateIdentityAuthRequestClient, mockCreatePersonalIdentity, mockStartInteractiveAuth);

describe("phone code auth routes", () => {
  let contractRequestId = 0;
  const consentRejections = [
    {
      code: "registration_consent_not_server_minted",
      reason: "absent",
      message: "A server-minted registration consent resolution is required.",
    },
    {
      code: "registration_consent_expired",
      reason: "superseded",
      message: "The registration consent resolution no longer matches the current required bundle.",
    },
    {
      code: "registration_consent_affirmation_required",
      reason: "affirmation-required",
      message: "Registration consent must be affirmed before identity creation.",
    },
  ] as const;
  const conflicts = [
    { code: "registration_operation_consent_disagreement", message: "Consent disagreement." },
    { code: "registration_operation_participant_disagreement", message: "Participant disagreement." },
    { code: "conflict", message: "Conflict." },
    { code: "display_name_already_taken", message: "Display name is already taken." },
  ] as const;

  function identityError(status: number, body: unknown) {
    return Object.assign(new Error("synthetic Identity failure"), { status, body });
  }

  async function requestWithIdentityError(status: number, body: unknown) {
    contractRequestId += 1;
    const phone = `+1312555${String(1000 + contractRequestId).padStart(4, "0")}`;
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("UPDATE identity_phone_code_tokens")) {
        return {
          rows: [
            {
              token_id: "cmd_contract",
              user_id: null,
              phone,
              code_hash: String(params[2]),
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              consumed_at: new Date().toISOString(),
              invalidated_at: null,
              failed_attempt_count: 0,
              code_matches: true,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const services = {
      db: { query },
      auth: { hashSecret: vi.fn((value: string) => `hashed:${value}`) },
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
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => {
        throw identityError(status, body);
      }),
    });
    return buildApp(services).request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.116.${contractRequestId}` },
      body: JSON.stringify({ tokenId: `cmd_contract_${contractRequestId}`, phone, code: "123456" }),
    });
  }

  it.each(consentRejections)("relays the recognized $code rejection body unchanged", async (rejection) => {
    const response = await requestWithIdentityError(400, { error: rejection });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: rejection });
  });

  it.each(conflicts)("relays the listed $code conflict body unchanged", async (conflict) => {
    const response = await requestWithIdentityError(409, { error: conflict });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: conflict });
  });

  it("redacts an unknown consent-like rejection instead of accepting a prefix match", async () => {
    const response = await requestWithIdentityError(400, {
      error: { code: "registration_consent_unrecognized", message: "secret source message" },
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
    expect(JSON.stringify(body)).not.toContain("secret source message");
  });

  it("partitions real routed failures", async () => {
    const app = buildApp({});
    const host = defineAuthHost({
      signInPath: "/sign-in",
      fallbackPath: "/account",
      defaultSuccessPath: "/account",
      accountSelectionPath: "/account/select",
      signedOutReturnTo: "/sign-in",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        app.request(new URL(String(input)).pathname.replace("/api/auth", ""), init),
      ),
    );
    try {
      for (const intent of ["phone-code-request", "phone-code-consume"]) {
        for (const action of [host.createSignInAction(), host.createRegisterAction()]) {
          const result = await action({
            request: new Request("https://marketplace.test/sign-in", {
              method: "POST",
              body: new URLSearchParams({ intent, code: "123456" }),
            }),
            params: {},
            context: {},
            url: new URL("https://marketplace.test/sign-in"),
            pattern: "/sign-in",
          });
          expect(result).toMatchObject({
            intent,
            classification: "FIELD",
            errors: { fieldErrors: { phone: ["Phone is required."] }, formErrors: [] },
          });
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves rejection parity and no write", async () => {
    const query = vi.fn();
    const getUserByPhone = vi.fn();
    const enqueueNotification = vi.fn();
    const app = buildApp({ db: { query }, identity: { getUserByPhone }, notificationOutbox: { enqueueNotification } });
    for (const phone of [undefined, "", "   "]) {
      for (const path of ["request", "consume"]) {
        const response = await app.request(`/phone-code/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, code: "123456" }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            code: "validation_failed",
            details: [{ field: "phone", code: "phone_required", message: "Phone is required." }],
          },
        });
      }
    }
    const codeOnly = await app.request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+13125550101" }),
    });
    expect(codeOnly.status).toBe(400);
    expect(await codeOnly.json()).not.toHaveProperty("error.details");
    expect(query).not.toHaveBeenCalled();
    expect(getUserByPhone).not.toHaveBeenCalled();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

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

  it("throttles phone code issuance per normalized phone and per IP", async () => {
    const enqueueNotification = vi.fn(async () => undefined);
    const services = {
      db: { query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })) },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => ({ user_id: "usr_existing" })),
      },
      registrationAdmission: {
        mode: "open",
        disposableEmailMode: "enforce",
        disposableEmailDomains: ["mailinator.com"],
      },
      notificationOutbox: { enqueueNotification },
    };
    const app = buildApp(services);

    const requestCode = (phone: string, forwardedFor: string) =>
      app.request("/phone-code/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": forwardedFor },
        body: JSON.stringify({ phone }),
      });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await requestCode("(312) 555-0200", `203.0.113.${70 + attempt}`);
      expect(response.status).toBe(200);
    }

    const identifierLimited = await requestCode("+1 312-555-0200", "203.0.113.74");
    expect(identifierLimited.status).toBe(429);
    await expect(identifierLimited.json()).resolves.toMatchObject({
      error: { code: "rate_limited", surface: "auth.phone-code.request.identifier" },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await requestCode(`312555${String(300 + attempt).padStart(4, "0")}`, "203.0.113.80");
      expect(response.status).toBe(200);
    }

    const ipLimited = await requestCode("3125550310", "203.0.113.80");
    expect(ipLimited.status).toBe(429);
    await expect(ipLimited.json()).resolves.toMatchObject({
      error: { code: "rate_limited", surface: "auth.phone-code.request.ip" },
    });
    expect(enqueueNotification).toHaveBeenCalledTimes(13);
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
      body: JSON.stringify({ tokenId: "cmd_phone_invalid", phone: "3125550101", code: "123456" }),
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
      body: JSON.stringify({ tokenId: "cmd_phone_normalized", phone: "3125550101", code: "123 456- " }),
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
              code_hash: String(params[2]),
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              consumed_at: new Date().toISOString(),
              invalidated_at: null,
              failed_attempt_count: 0,
              code_matches: true,
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
      body: JSON.stringify({
        tokenId: "cmd_phone_1",
        phone: "3125550101",
        code: "123456",
        displayName: "New Buyer",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
    });
    // The exact server-minted resolution reaches the constructor.
    expect(mockCreatePersonalIdentity).toHaveBeenCalledWith({
      phone: "+13125550101",
      displayName: "New Buyer",
      registrationConsent: SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION,
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
            rolePermissions: expect.arrayContaining(["pricing.view", "pricing.manage"]),
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
              invalidated_at: null,
              failed_attempt_count: 0,
              code_matches: true,
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
    const requestBody = JSON.stringify({ tokenId: "cmd_phone_2", phone: "3125550101", code: "654321" });

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
