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

// The REAL identity server module, with only the request client substituted.
// `isRegistrationConsentRejectionCode` is production's own predicate: a
// `startsWith("registration_consent_")` stand-in would recognize an invented
// code that production refuses, so every redaction case below would pass
// against a relay that actually leaks it.
vi.mock("@chase-sets/identity/server", async () => ({
  ...(await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server")),
  createIdentityAuthRequestClient: (...args: readonly unknown[]) =>
    withRegistrationConsentResolution(mockCreateIdentityAuthRequestClient(...args) ?? {}),
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
      token_hash: `hashed:magic_token_${relayMagicLinkAttempt}`,
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

/**
 * The exact bodies Identity publishes, declared LOCALLY in this suite.
 *
 * They are deliberately not hoisted into `registration-consent-test-support.ts`:
 * that module supplies only the server-minted resolution every relay already
 * consumes, and it stays byte-unchanged as a preserve control for the Auth
 * changed-path fence. Restating them per suite is the point -- each one has to
 * name the body it claims to relay.
 */
const RELAY_CONSENT_REJECTION_BODIES = [
  {
    code: "registration_consent_not_server_minted",
    reason: "absent",
    message: "A server-minted registration consent resolution is required.",
  },
  {
    code: "registration_consent_expired",
    reason: "stale",
    message: "The registration consent resolution is older than the freshness window.",
  },
  {
    code: "registration_consent_expired",
    reason: "superseded",
    message: "The registration consent resolution no longer matches the current required bundle.",
  },
  {
    code: "registration_consent_affirmation_required",
    reason: "unaffirmed",
    message: "The registration consent resolution carries requirements that were not affirmed.",
  },
] as const;

const RELAY_CONFLICT_BODIES = [
  {
    code: "registration_operation_consent_disagreement",
    message: "This registration operation already recorded a different consent bundle.",
  },
  {
    code: "registration_operation_participant_disagreement",
    message: "This registration operation contains a participant that disagrees with its claim.",
  },
  { code: "conflict", message: "Expected stream version does not match current version." },
  { code: "display_name_already_taken", message: "Display name is already taken." },
] as const;

const RELAY_GENERIC_INTERNAL_ERROR = { error: { code: "internal_error", message: "Internal server error." } } as const;

/** Present in the source error, and required to be absent from every response. */
const RELAY_SENTINEL_SECRET = "sentinel-db-dsn-postgres-relay-secret";

function relayIdentityFailure(status: number, body: unknown) {
  return Object.assign(new Error(`identity mutation failed with ${status}`), { status, body });
}

let relayMagicLinkAttempt = 0;

/** Drive the real magic-link first-use relay to Identity's failure. */
async function attemptRelayRegistration(failure: unknown) {
  relayMagicLinkAttempt += 1;
  const services = createServices();
  services.identity.getUser.mockResolvedValue(null);
  services.identity.getUserByEmail.mockResolvedValue(null);
  mockConsumeMagicLinkToken.mockResolvedValue({
    token_id: `cmd_relay_${relayMagicLinkAttempt}`,
    user_id: null,
    email: `relay-${relayMagicLinkAttempt}@chasesets.test`,
    token_hash: "hashed:magic_token",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
  });
  mockCreateIdentityAuthRequestClient.mockReturnValue({
    createPersonalIdentity: vi.fn(async () => {
      throw failure;
    }),
    verifyEmailContactMethod: vi.fn(async () => ({ ok: true, userId: "usr_relay", snapshots: [] })),
  });
  mockStartInteractiveAuth.mockResolvedValue({ type: "session-started", sessionToken: "session_token" });
  const app = buildApp(services);
  app.onError(errorHandler);

  return app.request("/magic-link/consume", {
    method: "POST",
    // A fresh client key per attempt: the consume route rate-limits by network
    // as well as by token, and this matrix issues more attempts than one client
    // may make.
    headers: { "Content-Type": "application/json", "x-forwarded-for": `198.51.100.${relayMagicLinkAttempt}` },
    // The consume route rate-limits per token hash, and this matrix issues more
    // attempts than one link may be consumed.
    body: JSON.stringify({ token: `magic_token_${relayMagicLinkAttempt}` }),
  });
}

describe("AC10 the JSON relay family preserves Identity's exact bodies", () => {
  it.each(RELAY_CONSENT_REJECTION_BODIES)(
    "relays the $code/$reason rejection body unchanged with status 400",
    async (rejection) => {
      const response = await attemptRelayRegistration(relayIdentityFailure(400, { error: rejection }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: rejection });
    },
  );

  it.each(RELAY_CONFLICT_BODIES)("relays the $code conflict body unchanged with status 409", async (conflict) => {
    const response = await attemptRelayRegistration(relayIdentityFailure(409, { error: conflict }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: conflict });
  });

  it("redacts an unrecognized 400 into the exact generic 500", async () => {
    // `registration_consent_unrecognized` is not a code Identity publishes. The
    // real predicate refuses it, so it falls through to the mounted platform
    // handler -- a `startsWith` stand-in would have relayed it verbatim.
    const response = await attemptRelayRegistration(
      relayIdentityFailure(400, {
        error: { code: "registration_consent_unrecognized", message: RELAY_SENTINEL_SECRET },
      }),
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(RELAY_GENERIC_INTERNAL_ERROR);
    expect(text).not.toContain(RELAY_SENTINEL_SECRET);
  });

  it("redacts a non-409 failure and leaks neither its code nor an injected secret", async () => {
    const response = await attemptRelayRegistration(
      relayIdentityFailure(503, { error: { code: "upstream_unavailable", message: RELAY_SENTINEL_SECRET } }),
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(RELAY_GENERIC_INTERNAL_ERROR);
    expect(text).not.toContain(RELAY_SENTINEL_SECRET);
    expect(text).not.toContain("upstream_unavailable");
  });
});
