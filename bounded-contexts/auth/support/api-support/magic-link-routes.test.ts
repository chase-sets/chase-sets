import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV } from "@chase-sets/platform-runtime/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import {
  SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION,
  withRegistrationConsentResolution,
} from "./registration-consent-test-support";
import type { AuthServices, RegistrationAdmissionHostConfig } from "../runtime-support/services";
import type { AuthIdentityInvitationRow } from "../auth-support/identity-projection";
import { registerMagicLinkRoutes } from "./magic-link-routes";
import type { AuthApiEnv } from "./support";
import {
  SAME_SITE_TEST_ORIGIN,
  UNSAFE_AUTH_PATHS,
  VALID_AUTH_PATHS,
} from "../auth-support/same-site-path.test-support";
import { buildAuthSessionTransactionalEmailProjectionHandlers } from "../../features/sessions/integrations/transactional-email/transactional-email-projector";

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

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");
  return {
    ...actual,
    createIdentityAuthRequestClient: (...args: readonly unknown[]) =>
      withRegistrationConsentResolution(mockCreateIdentityAuthRequestClient(...args) ?? {}),
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
        tenantId: "ten_test",
        trace: {},
      },
    ),
    routes: (app) => {
      registerMagicLinkRoutes(app, services as AuthServices);
      app.onError(errorHandler);
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
  it.each([...UNSAFE_AUTH_PATHS, ...VALID_AUTH_PATHS])(
    "Auth same-site URL boundary: request-to-projector %j",
    async (path) => {
      vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
      const index = [...UNSAFE_AUTH_PATHS, ...VALID_AUTH_PATHS].indexOf(path);
      const services = createServices();
      const append = vi.fn(async (_input: { events: readonly { payload: Record<string, unknown> }[] }) => ({
        version: 1,
      }));
      const app = buildApp({ ...services, eventStore: { appendToStream: append } });
      const response = await app.request(`${SAME_SITE_TEST_ORIGIN}/magic-link/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.120.${index + 1}` },
        body: JSON.stringify({ email: `boundary-${index}@example.test`, landingPath: path, returnTo: path }),
      });
      expect(response.status).toBe(200);
      const data = append.mock.calls[0]![0].events[0]!.payload;
      const valid = VALID_AUTH_PATHS.includes(path);
      expect(data.landingPath).toBe(valid ? path : "/sign-in/magic");
      expect(data.returnTo).toBe(valid ? path : null);
      expect(data).not.toHaveProperty("token");
      const outbox = {
        enqueueNotification: vi.fn(async (_input: { message: { templateData: unknown } }) => undefined),
      };
      const delivery = {
        getMagicLinkDeliveryToken: vi.fn(async () => "synthetic-boundary-token"),
        clearMagicLinkDeliveryToken: vi.fn(async () => undefined),
      };
      const handlers = buildAuthSessionTransactionalEmailProjectionHandlers(outbox, delivery);
      await handlers["auth.magic-link.requested"]!({
        id: "evt_boundary",
        type: "auth.magic-link.requested",
        globalPosition: "1",
        trace: { traceId: "boundary" },
        timing: { occurredAt: "2026-10-28T00:00:00.000Z", recordedAt: "2026-10-28T00:00:01.000Z" },
        data,
      } as never);
      const template = outbox.enqueueNotification.mock.calls[0]![0].message.templateData as { magicLink: string };
      const url = new URL(template.magicLink);
      expect(url.origin).toBe(SAME_SITE_TEST_ORIGIN);
      expect(url.pathname).toBe(new URL(valid ? path : "/sign-in/magic", SAME_SITE_TEST_ORIGIN).pathname);
      expect(url.searchParams.get("token")).toBe("synthetic-boundary-token");
      expect(url.searchParams.get("returnTo")).toBe(valid ? path : null);
      expect(delivery.clearMagicLinkDeliveryToken).toHaveBeenCalledWith(data.tokenId);
    },
  );

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
    const token = `magic_token_contract_${contractRequestId}`;
    const services = createServices();
    services.identity.getUser.mockResolvedValue(null);
    services.identity.getUserByEmail.mockResolvedValue(null);
    mockConsumeMagicLinkToken.mockResolvedValue({
      token_id: "cmd_contract",
      user_id: null,
      email: "contract@chasesets.test",
      token_hash: `hashed:${token}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => {
        throw identityError(status, body);
      }),
      verifyEmailContactMethod: vi.fn(async () => ({ ok: true, userId: "usr_contract", snapshots: [] })),
    });
    return buildApp(services).request("/magic-link/consume", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `203.0.117.${contractRequestId}`,
      },
      body: JSON.stringify({ token }),
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

  it("redacts a 5xx Identity failure instead of exposing its source message", async () => {
    const response = await requestWithIdentityError(500, {
      error: { code: "unknown", message: "secret source message" },
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
    expect(JSON.stringify(body)).not.toContain("secret source message");
  });

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
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        membershipsOverride: [
          expect.objectContaining({
            roleKey: "owner",
            rolePermissions: expect.arrayContaining(["pricing.view", "pricing.manage"]),
          }),
        ],
      }),
    );
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

  it("forwards the server-minted registration consent submission to the identity constructor", async () => {
    const services = createServices();
    services.identity.getUser.mockResolvedValue(null);
    services.identity.getUserByEmail.mockResolvedValue(null);
    mockConsumeMagicLinkToken.mockResolvedValue({
      token_id: "cmd_consent",
      user_id: null,
      email: "consent@chasesets.test",
      token_hash: "hashed:magic_token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    const createPersonalIdentity = vi.fn(async () => ({
      userId: "usr_consent",
      accountId: "acc_consent",
      membershipId: "mbr_consent",
    }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity,
      verifyEmailContactMethod: vi.fn(async () => ({ ok: true, userId: "usr_consent", snapshots: [] })),
    });
    mockStartInteractiveAuth.mockResolvedValue({ type: "session-started", sessionToken: "session_token" });

    const response = await buildApp(services).request("/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "magic_token" }),
    });

    expect(response.status).toBe(200);
    expect(createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ registrationConsent: SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION }),
    );
  });
});
