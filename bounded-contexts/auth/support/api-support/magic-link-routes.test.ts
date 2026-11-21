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
import { SessionClosureRequired } from "../../features/sessions/api/owner-epochs";
import type { PendingMagicLinkRegistration, PendingRegistration } from "../auth-support/store";

const {
  mockConsumeMagicLinkToken,
  mockCreateIdentityAuthRequestClient,
  mockFinishPendingMagicLinkRegistration,
  mockHasPendingMagicLinkRegistration,
  mockInsertActiveAuthIdentityMembershipMirror,
  mockInsertCreatedAuthIdentityAccountMirror,
  mockInsertMagicLinkToken,
  mockInsertPasskeyCredentialIfAbsent,
  mockInsertPasswordCredentialIfAbsent,
  mockInsertRegisteredAuthIdentityUserMirror,
  mockLockPendingMagicLinkRegistration,
  mockStartInteractiveAuth,
  mockStartOrResumeReservedAuth,
  mockUpsertSessionTokenOnClient,
} = vi.hoisted(() => ({
  mockConsumeMagicLinkToken: vi.fn(),
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockFinishPendingMagicLinkRegistration: vi.fn(),
  mockHasPendingMagicLinkRegistration: vi.fn(),
  mockInsertActiveAuthIdentityMembershipMirror: vi.fn(),
  mockInsertCreatedAuthIdentityAccountMirror: vi.fn(),
  mockInsertMagicLinkToken: vi.fn(),
  mockInsertPasskeyCredentialIfAbsent: vi.fn(),
  mockInsertPasswordCredentialIfAbsent: vi.fn(),
  mockInsertRegisteredAuthIdentityUserMirror: vi.fn(),
  mockLockPendingMagicLinkRegistration: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
  mockStartOrResumeReservedAuth: vi.fn(),
  mockUpsertSessionTokenOnClient: vi.fn(),
}));

vi.mock("../auth-support/store", () => ({
  consumeMagicLinkToken: mockConsumeMagicLinkToken,
  finishPendingMagicLinkRegistration: mockFinishPendingMagicLinkRegistration,
  hasPendingMagicLinkRegistration: mockHasPendingMagicLinkRegistration,
  insertMagicLinkToken: mockInsertMagicLinkToken,
  insertPasskeyCredentialIfAbsent: mockInsertPasskeyCredentialIfAbsent,
  insertPasswordCredentialIfAbsent: mockInsertPasswordCredentialIfAbsent,
  lockPendingMagicLinkRegistration: mockLockPendingMagicLinkRegistration,
  upsertSessionTokenOnClient: mockUpsertSessionTokenOnClient,
}));

vi.mock("../auth-support/identity-projection", async () => ({
  ...(await vi.importActual<typeof import("../auth-support/identity-projection")>(
    "../auth-support/identity-projection",
  )),
  insertActiveAuthIdentityMembershipMirror: mockInsertActiveAuthIdentityMembershipMirror,
  insertCreatedAuthIdentityAccountMirror: mockInsertCreatedAuthIdentityAccountMirror,
  insertRegisteredAuthIdentityUserMirror: mockInsertRegisteredAuthIdentityUserMirror,
}));

vi.mock("../runtime-support/services", () => ({
  startInteractiveAuth: mockStartInteractiveAuth,
  startOrResumeReservedAuth: mockStartOrResumeReservedAuth,
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

describe("Pending Registration magic-link consume", () => {
  const RESERVED_USER = "usr_reserved";
  const RESERVED_SESSION = "ses_reserved";
  const STAGED_EMAIL = "staged@chasesets.test";
  const STAGED_HASH = "scrypt$staged-password-hash";
  const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
  const COMMITTED = [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "SET LOCAL statement_timeout = '5s'",
    "SET LOCAL lock_timeout = '5s'",
  ];
  let requestId = 0;

  function pendingRegistration(): PendingRegistration {
    return {
      displayName: "Staged Collector",
      givenName: "Staged",
      familyName: "Collector",
      registrationConsent: { ...SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION, affirmed: true },
      reservedUserId: RESERVED_USER,
      reservedSessionId: RESERVED_SESSION,
      password: { credentialId: "pwd_reserved", secretHash: STAGED_HASH },
      passkey: {
        credentialId: "pk_reserved",
        externalCredentialId: "ext_reserved",
        label: "Laptop",
        publicKey: "staged-public-key",
        signCount: 0,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    };
  }

  function pendingLink(): PendingMagicLinkRegistration {
    return { tokenId: "cmd_pending", userId: null, email: STAGED_EMAIL, pendingRegistration: pendingRegistration() };
  }

  /** A lock pool whose single client logs every statement, beside the route's own steps. */
  function setup(options: Readonly<{ failCommit?: boolean; withoutLocks?: boolean }> = {}) {
    const log: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        log.push(sql);
        if (sql === "COMMIT" && options.failCommit) {
          throw new Error("synthetic connection loss before commit");
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const lockPool = { query: client.query, connect: vi.fn(async () => client) };
    // The ordinary Auth pool, where the mirrors commit in their own short transaction.
    const mirrorLog: string[] = [];
    const mirrorClient = {
      query: vi.fn(async (sql: string) => {
        mirrorLog.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const sessionEpochs = {
      settleClosure: vi.fn(async (_keys: readonly string[]) => {
        log.push("settle closure");
      }),
    };
    const services = {
      ...createServices(),
      pool: { query: mirrorClient.query, connect: vi.fn(async () => mirrorClient) },
      ...(options.withoutLocks ? {} : { pendingRegistrationLocks: lockPool }),
      sessionEpochs,
    };
    services.identity.getUser.mockResolvedValue(null);
    services.identity.getUserByEmail.mockResolvedValue(null);
    mockConsumeMagicLinkToken.mockResolvedValue(null);
    mockHasPendingMagicLinkRegistration.mockResolvedValue(true);
    mockLockPendingMagicLinkRegistration.mockResolvedValue(pendingLink());
    mockUpsertSessionTokenOnClient.mockImplementation(async () => {
      log.push("session token");
    });
    mockFinishPendingMagicLinkRegistration.mockImplementation(async () => {
      log.push("consume and clear");
    });
    mockStartOrResumeReservedAuth.mockImplementation(
      async (
        _services: unknown,
        params: { userId: string; sessionId: string },
        writeSessionToken: (token: unknown) => Promise<void>,
      ) => {
        await writeSessionToken({
          sessionId: params.sessionId,
          tokenHash: "hashed:session_token",
          expiresAt: SESSION_EXPIRES_AT,
        });
        return {
          type: "session-started",
          userId: params.userId,
          sessionId: params.sessionId,
          sessionToken: "session_token",
          session: { session_id: params.sessionId, expires_at: SESSION_EXPIRES_AT },
          memberships: [],
        };
      },
    );
    const mutations = {
      createPersonalIdentity: vi.fn(async (_input: unknown) => ({
        userId: RESERVED_USER,
        accountId: "acc_reserved",
        membershipId: "mbr_reserved",
      })),
      verifyEmailContactMethod: vi.fn(async (input: { userId: string }) => ({
        ok: true,
        userId: input.userId,
        snapshots: [],
      })),
      enablePasswordCredential: vi.fn(async (_input: unknown) => ({ ok: true, snapshots: [] })),
      registerPasskeyCredential: vi.fn(async (_input: unknown) => ({ ok: true, snapshots: [] })),
    };
    mockCreateIdentityAuthRequestClient.mockReturnValue(mutations);
    return { services, log, client, lockPool, sessionEpochs, mutations, mirrorClient, mirrorLog };
  }

  function consume(services: unknown, body: Record<string, unknown> = {}) {
    requestId += 1;
    return buildApp(services).request("/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.118.${requestId}` },
      body: JSON.stringify({ token: `pending_token_${requestId}`, ...body }),
    });
  }

  function identityError(status: number, body: unknown) {
    return Object.assign(new Error("synthetic Identity failure"), { status, body });
  }

  function expectNoRegistrationWrites(mutations: ReturnType<typeof setup>["mutations"]) {
    expect(mutations.enablePasswordCredential).not.toHaveBeenCalled();
    expect(mutations.registerPasskeyCredential).not.toHaveBeenCalled();
    expect(mockInsertPasswordCredentialIfAbsent).not.toHaveBeenCalled();
    expect(mockInsertPasskeyCredentialIfAbsent).not.toHaveBeenCalled();
    expect(mockInsertCreatedAuthIdentityAccountMirror).not.toHaveBeenCalled();
    expect(mockInsertRegisteredAuthIdentityUserMirror).not.toHaveBeenCalled();
    expect(mockInsertActiveAuthIdentityMembershipMirror).not.toHaveBeenCalled();
  }

  it("finishes a new registration from the staged payload and responds only after the lock transaction commits", async () => {
    const { services, log, client, mutations, mirrorClient, mirrorLog } = setup();

    const response = await consume(services);

    expect(response.status).toBe(200);
    expect(mirrorLog).toEqual(["BEGIN", "COMMIT"]);
    expect(mirrorClient.release).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body).toMatchObject({ type: "session-started", userId: RESERVED_USER, sessionToken: "session_token" });
    expect(JSON.stringify(body)).not.toContain(STAGED_HASH);
    expect(log).toEqual([...COMMITTED, "session token", "consume and clear", "COMMIT"]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mockConsumeMagicLinkToken).toHaveBeenCalledWith(services.db, `hashed:pending_token_${requestId}`);
    expect(mockLockPendingMagicLinkRegistration).toHaveBeenCalledWith(client, `hashed:pending_token_${requestId}`);
    expect(mutations.createPersonalIdentity).toHaveBeenCalledWith({
      email: STAGED_EMAIL,
      displayName: "Staged Collector",
      givenName: "Staged",
      familyName: "Collector",
      registrationConsent: { ...SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION, affirmed: true },
      foundersBetaAccessStartedAt: undefined,
      reservedUserId: RESERVED_USER,
    });
    expect(mutations.verifyEmailContactMethod).toHaveBeenCalledWith({ userId: RESERVED_USER, email: STAGED_EMAIL });
    expect(mutations.enablePasswordCredential).toHaveBeenCalledWith({
      userId: RESERVED_USER,
      credentialId: "pwd_reserved",
    });
    // The staged hash is stored as-is under its reserved id: never rehashed, never replaced.
    expect(mockInsertPasswordCredentialIfAbsent).toHaveBeenCalledWith(services.db, {
      credentialId: "pwd_reserved",
      secretHash: STAGED_HASH,
      userId: RESERVED_USER,
    });
    expect(mutations.registerPasskeyCredential).toHaveBeenCalledWith({
      userId: RESERVED_USER,
      credentialId: "pk_reserved",
    });
    expect(mockInsertPasskeyCredentialIfAbsent).toHaveBeenCalledWith(services.db, {
      ...pendingRegistration().passkey,
      userId: RESERVED_USER,
    });
    expect(mockInsertCreatedAuthIdentityAccountMirror).toHaveBeenCalledWith(mirrorClient, {
      accountId: "acc_reserved",
      displayName: "Staged Collector",
    });
    expect(mockInsertRegisteredAuthIdentityUserMirror).toHaveBeenCalledWith(
      mirrorClient,
      expect.objectContaining({
        userId: RESERVED_USER,
        displayName: "Staged Collector",
        givenName: "Staged",
        familyName: "Collector",
        email: STAGED_EMAIL,
        authMethods: ["password", "passkey"],
        passwordCredentialId: "pwd_reserved",
        passkeyCredentialIds: ["pk_reserved"],
      }),
    );
    expect(mockInsertActiveAuthIdentityMembershipMirror).toHaveBeenCalledWith(
      mirrorClient,
      expect.objectContaining({ membershipId: "mbr_reserved", accountId: "acc_reserved", roleKey: "owner" }),
    );
    expect(mockStartOrResumeReservedAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: RESERVED_USER,
        sessionId: RESERVED_SESSION,
        accountId: "acc_reserved",
        authenticationMethod: "magic-link",
        membershipsOverride: [expect.objectContaining({ membershipId: "mbr_reserved", roleKey: "owner" })],
      }),
      expect.any(Function),
    );
    expect(mockUpsertSessionTokenOnClient).toHaveBeenCalledWith(
      client,
      { sessionId: RESERVED_SESSION, tokenHash: "hashed:session_token", expiresAt: SESSION_EXPIRES_AT },
      services.sessionEpochs,
    );
    expect(mockFinishPendingMagicLinkRegistration).toHaveBeenCalledWith(client, "cmd_pending");
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("does not report success when the connection is lost before commit", async () => {
    const { services, log, client } = setup({ failCommit: true });

    const response = await consume(services);

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("session_token");
    expect(log).toEqual([...COMMITTED, "session token", "consume and clear", "COMMIT", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("asks Identity only for missing writes when the reserved User already exists, without re-admitting it", async () => {
    const { services, log, mutations } = setup();
    services.identity.getUserByEmail.mockResolvedValue({ user_id: RESERVED_USER });
    // Invitation-only admission would refuse this email; the reserved User was admitted by an earlier attempt.
    services.registrationAdmission = {
      mode: "invitation",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
    };

    const response = await consume(services);

    expect(response.status).toBe(200);
    expect(services.identity.findPendingInvitationByEmail).not.toHaveBeenCalled();
    expect(mutations.createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ reservedUserId: RESERVED_USER, foundersBetaAccessStartedAt: undefined }),
    );
    expect(mockInsertPasswordCredentialIfAbsent).toHaveBeenCalledTimes(1);
    expect(mockInsertPasskeyCredentialIfAbsent).toHaveBeenCalledTimes(1);
    expect(log).toEqual([...COMMITTED, "session token", "consume and clear", "COMMIT"]);
  });

  it("signs a different existing User in normally, without the staged details, credentials or mirrors", async () => {
    const { services, log, mutations } = setup();
    services.identity.getUserByEmail.mockResolvedValue({ user_id: "usr_existing" });

    const response = await consume(services, { accountId: "acc_existing" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ userId: "usr_existing" });
    expect(mutations.createPersonalIdentity).not.toHaveBeenCalled();
    expectNoRegistrationWrites(mutations);
    expect(mutations.verifyEmailContactMethod).toHaveBeenCalledWith({ userId: "usr_existing", email: STAGED_EMAIL });
    expect(mockStartOrResumeReservedAuth).toHaveBeenCalledWith(
      services,
      expect.not.objectContaining({ membershipsOverride: expect.anything() }),
      expect.any(Function),
    );
    expect(mockStartOrResumeReservedAuth.mock.calls[0]![1]).toMatchObject({
      userId: "usr_existing",
      sessionId: RESERVED_SESSION,
      accountId: "acc_existing",
      authenticationMethod: "magic-link",
    });
    expect(log).toEqual([...COMMITTED, "session token", "consume and clear", "COMMIT"]);
  });

  it("returns an existing User's account selection and consumes the link without a Session Token", async () => {
    const { services, log } = setup();
    services.identity.getUserByEmail.mockResolvedValue({ user_id: "usr_existing" });
    mockStartOrResumeReservedAuth.mockResolvedValue({
      type: "account-selection-required",
      userId: "usr_existing",
      selectionToken: "selection_token",
      selectionExpiresAt: SESSION_EXPIRES_AT,
      memberships: [],
    });

    const response = await consume(services);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ type: "account-selection-required" });
    expect(log).toEqual([...COMMITTED, "consume and clear", "COMMIT"]);
  });

  it("signs in the User that won a projection-lagged contact claim, with none of the staged details", async () => {
    const { services, mutations } = setup();
    services.identity.getUserByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce({ user_id: "usr_winner" });
    mutations.createPersonalIdentity.mockRejectedValue(
      identityError(409, { error: { code: "conflict", message: "Conflict." } }),
    );

    const response = await consume(services);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ userId: "usr_winner" });
    expectNoRegistrationWrites(mutations);
    expect(mockStartOrResumeReservedAuth.mock.calls[0]![1]).toMatchObject({ userId: "usr_winner" });
    expect(mockFinishPendingMagicLinkRegistration).toHaveBeenCalledTimes(1);
  });

  it("leaves the link retryable and writes nothing when a conflicting claim has no visible winner", async () => {
    const { services, log, mutations } = setup();
    const conflict = { error: { code: "conflict", message: "Conflict." } };
    mutations.createPersonalIdentity.mockRejectedValue(identityError(409, conflict));

    const response = await consume(services);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(conflict);
    expectNoRegistrationWrites(mutations);
    expect(mutations.verifyEmailContactMethod).not.toHaveBeenCalled();
    expect(mockStartOrResumeReservedAuth).not.toHaveBeenCalled();
    expect(log).toEqual([...COMMITTED, "COMMIT"]);
  });

  it("commits only the link's consumption on a terminal consent rejection", async () => {
    const { services, log, mutations } = setup();
    const rejection = {
      error: {
        code: "registration_consent_expired",
        reason: "superseded",
        message: "The registration consent resolution no longer matches the current required bundle.",
      },
    };
    mutations.createPersonalIdentity.mockRejectedValue(identityError(400, rejection));

    const response = await consume(services);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(rejection);
    expectNoRegistrationWrites(mutations);
    expect(mockStartOrResumeReservedAuth).not.toHaveBeenCalled();
    expect(log).toEqual([...COMMITTED, "consume and clear", "COMMIT"]);
  });

  it("commits only the link's consumption when admission refuses a new User", async () => {
    const { services, log, mutations } = setup();
    services.registrationAdmission = {
      mode: "invitation",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
    };

    const response = await consume(services);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "registration_admission_required" } });
    expect(mutations.createPersonalIdentity).not.toHaveBeenCalled();
    expectNoRegistrationWrites(mutations);
    expect(log).toEqual([...COMMITTED, "consume and clear", "COMMIT"]);
  });

  it("refuses with 503 and leaves the link untouched when the host supplies no lock pool", async () => {
    const { services, lockPool, mutations } = setup({ withoutLocks: true });

    const response = await consume(services);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: expect.any(String) });
    expect(lockPool.connect).not.toHaveBeenCalled();
    expect(mockLockPendingMagicLinkRegistration).not.toHaveBeenCalled();
    expect(mockFinishPendingMagicLinkRegistration).not.toHaveBeenCalled();
    expect(mutations.createPersonalIdentity).not.toHaveBeenCalled();
  });

  it("rolls back and releases the lock client, settles a pending Session closure on the ordinary pool, then retries", async () => {
    const { services, log, client, sessionEpochs } = setup();
    mockUpsertSessionTokenOnClient.mockRejectedValueOnce(new SessionClosureRequired([`session/${RESERVED_SESSION}`]));

    const response = await consume(services);

    expect(response.status).toBe(200);
    expect(log).toEqual([
      ...COMMITTED,
      "ROLLBACK",
      "settle closure",
      ...COMMITTED,
      "session token",
      "consume and clear",
      "COMMIT",
    ]);
    expect(sessionEpochs.settleClosure).toHaveBeenCalledWith([`session/${RESERVED_SESSION}`]);
    expect(client.release).toHaveBeenCalledTimes(2);
    // The retry starts again from the claim; Identity and the reserved Session are idempotent.
    expect(mockLockPendingMagicLinkRegistration).toHaveBeenCalledTimes(2);
    expect(mockStartOrResumeReservedAuth).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable 401 without consuming when the reserved Session cannot be resumed", async () => {
    const { services, log } = setup();
    // A foreign, revoked, expired or superseded reserved Session, or a projection miss.
    mockStartOrResumeReservedAuth.mockResolvedValue(null);

    const response = await consume(services);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Magic link is invalid or has expired." });
    expect(mockFinishPendingMagicLinkRegistration).not.toHaveBeenCalled();
    expect(log).toEqual([...COMMITTED, "COMMIT"]);
  });

  it("rolls back without consuming when another step fails", async () => {
    const { services, log, client, mutations } = setup();
    mutations.verifyEmailContactMethod.mockRejectedValue(new Error("synthetic Identity outage"));

    const response = await consume(services);

    expect(response.status).toBe(500);
    expect(mockFinishPendingMagicLinkRegistration).not.toHaveBeenCalled();
    expect(log).toEqual([...COMMITTED, "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when the claim finds no live Pending Registration (finished by another holder or expired)", async () => {
    const { services, mutations } = setup();
    mockLockPendingMagicLinkRegistration.mockResolvedValue(null);

    const response = await consume(services);

    expect(response.status).toBe(401);
    expect(mutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(mockFinishPendingMagicLinkRegistration).not.toHaveBeenCalled();
  });

  it("rejects a replayed link without touching the lock pool", async () => {
    const { services, lockPool } = setup();
    mockHasPendingMagicLinkRegistration.mockResolvedValue(false);

    const response = await consume(services);

    expect(response.status).toBe(401);
    expect(lockPool.connect).not.toHaveBeenCalled();
  });
});
