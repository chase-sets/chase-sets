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
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  decodeCommitReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import type { AuthServices, RegistrationAdmissionHostConfig } from "../runtime-support/services";
import type { AuthIdentityInvitationRow } from "../auth-support/identity-projection";
import { registerRegistrationRoutes } from "./register-routes";
import type { AuthApiEnv } from "./support";
import { createAuthApiClient } from "../../client";

const { mockCreateIdentityAuthRequestClient, mockStartInteractiveAuth } = vi.hoisted(() => ({
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
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
      registerRegistrationRoutes(app, services as AuthServices);
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
    auth: {
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
      hashPassword: vi.fn(async (value: string) => `password:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserByEmail: vi.fn(async (_email: string): Promise<{ user_id: string } | null> => null),
      findPendingInvitationByEmail: vi.fn(async (_email: string): Promise<AuthIdentityInvitationRow | null> => null),
    },
    registrationAdmission,
  };
}

function withCommandReceipt<T extends object>(body: T, source: SourceCommitPosition): T {
  Object.defineProperty(body, "commandReceipt", {
    value: {
      mode: "eventual",
      commitEventIds: source.eventIds,
      commitPositions: [source],
    },
    enumerable: false,
  });
  return body;
}

function registrationRequestHeaders(clientAddress: string) {
  return {
    "Content-Type": "application/json",
    "x-forwarded-for": clientAddress,
  };
}

useMockReset();

describe("registration auth routes", () => {
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

  it.each(consentRejections)("relays the recognized $code rejection body unchanged", async (rejection) => {
    const services = createServices();
    const createPersonalIdentity = vi.fn(async () => {
      throw identityError(400, { error: rejection });
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({ createPersonalIdentity, enablePasswordCredential: vi.fn() });

    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders(`203.0.113.${220 + consentRejections.indexOf(rejection)}`),
      body: JSON.stringify({ email: `${rejection.code}@chasesets.test`, displayName: "Consent Contract" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: rejection });
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it.each(conflicts)("relays the listed $code conflict body unchanged", async (conflict) => {
    const services = createServices();
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => {
        throw identityError(409, { error: conflict });
      }),
      enablePasswordCredential: vi.fn(),
    });

    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders(`203.0.114.${220 + conflicts.indexOf(conflict)}`),
      body: JSON.stringify({ email: `${conflict.code}@chasesets.test`, displayName: "Conflict Contract" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: conflict });
  });

  it("relays an otherwise unknown 409 body without exposing a source exception", async () => {
    const services = createServices();
    const body = { error: { code: "unknown_conflict", message: "Conflict." } };
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => {
        throw identityError(409, body);
      }),
      enablePasswordCredential: vi.fn(),
    });
    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.114.250"),
      body: JSON.stringify({ email: "unknown-conflict@chasesets.test", displayName: "Conflict Contract" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(body);
  });

  // The existing-email discriminator is the only conflict this route owns. Every
  // row runs the real /register handler; only the server-normalized email match
  // may answer email_already_taken, and the screening order before it is unchanged.
  describe("existing-email conflict matrix", () => {
    const existingEmail = "existing.user@chasesets.test";
    const existingAccountCode = "email_already_taken";

    function servicesWithExistingAccount(mode: RegistrationAdmissionHostConfig["mode"] = "open") {
      const services = createServices();
      services.registrationAdmission = { ...services.registrationAdmission, mode };
      services.identity.getUserByEmail.mockImplementation(async (email: string) =>
        email === existingEmail ? { user_id: "usr_existing" } : null,
      );
      return services;
    }

    function identityRefusal(status: number, body: unknown) {
      const createPersonalIdentity = vi.fn(async () => {
        throw identityError(status, body);
      });
      mockCreateIdentityAuthRequestClient.mockReturnValue({
        createPersonalIdentity,
        enablePasswordCredential: vi.fn(),
      });
      return createPersonalIdentity;
    }

    async function register(services: ReturnType<typeof createServices>, clientAddress: string, email: string) {
      const response = await buildApp(services).request("/register", {
        method: "POST",
        headers: registrationRequestHeaders(clientAddress),
        body: JSON.stringify({ email, password: "existing-password", displayName: "Existing User" }),
      });
      return { status: response.status, body: (await response.json()) as { error?: unknown } };
    }

    it("answers email_already_taken only for the server-normalized existing email, before any Identity effect", async () => {
      const services = servicesWithExistingAccount();
      const createPersonalIdentity = identityRefusal(409, { error: { code: "display_name_already_taken" } });

      const result = await register(services, "198.51.100.10", "  Existing.User@ChaseSets.TEST ");

      expect(result).toEqual({
        status: 409,
        body: { error: { code: existingAccountCode, message: "A user already exists for that email." } },
      });
      expect(services.identity.getUserByEmail).toHaveBeenCalledWith(existingEmail);
      expect(createPersonalIdentity).not.toHaveBeenCalled();
      expect(services.auth.hashPassword).not.toHaveBeenCalled();
      expect(services.db.query).not.toHaveBeenCalled();
      expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
    });

    it.each([
      [21, 409, { error: { code: "display_name_already_taken", message: "Display name is already taken." } }],
      [22, 409, { error: { code: "registration_operation_consent_disagreement", message: "Consent disagreement." } }],
      [23, 409, { error: { code: "registration_operation_participant_disagreement", message: "Disagreement." } }],
      [24, 409, { error: { code: "conflict", message: "Conflict." } }],
      [25, 409, { error: { code: "unknown_conflict", message: "Conflict." } }],
      [26, 409, "unstructured identity mutation conflict"],
      [27, 400, { error: consentRejections[0] }],
      [28, 400, { error: consentRejections[2] }],
    ] as const)("keeps a distinct refusal for a new email (row %i: %i %j)", async (row, status, identityBody) => {
      const services = servicesWithExistingAccount();
      const createPersonalIdentity = identityRefusal(status, identityBody);

      const result = await register(services, `198.51.100.${row}`, "New.User@ChaseSets.test");

      expect(services.identity.getUserByEmail).toHaveBeenCalledWith("new.user@chasesets.test");
      expect(createPersonalIdentity).toHaveBeenCalledOnce();
      expect(result.status).toBe(status);
      const code = (result.body.error as { code?: unknown } | undefined)?.code;
      expect(code).toBe(
        typeof identityBody === "string" ? "identity_mutation_conflict" : (identityBody.error as { code: string }).code,
      );
      expect(code).not.toBe(existingAccountCode);
      expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
    });

    it("screens admission and disposable domains before the existing-email lookup, so neither enumerates", async () => {
      const invitationOnly = servicesWithExistingAccount("invitation");
      const admission = await register(invitationOnly, "198.51.100.230", existingEmail);
      expect(admission.status).toBe(403);
      expect(admission.body).toMatchObject({ error: { code: "registration_admission_required" } });
      expect(invitationOnly.identity.getUserByEmail).not.toHaveBeenCalled();

      const disposable = servicesWithExistingAccount();
      disposable.identity.getUserByEmail.mockImplementation(async () => ({ user_id: "usr_existing" }));
      const domain = await register(disposable, "198.51.100.231", "existing.user@mailinator.com");
      expect(domain.status).toBe(403);
      expect(domain.body).toMatchObject({ error: { code: "disposable_email_domain" } });
      expect(disposable.identity.getUserByEmail).not.toHaveBeenCalled();
    });

    it("rate limits before the existing-email lookup", async () => {
      const services = servicesWithExistingAccount();
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await register(services, "198.51.100.232", existingEmail)).status).toBe(409);
      }
      services.identity.getUserByEmail.mockClear();

      const limited = await register(services, "198.51.100.232", existingEmail);

      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ error: { code: "rate_limited", surface: "auth.register.ip" } });
      expect(services.identity.getUserByEmail).not.toHaveBeenCalled();
    });
  });

  it.each([
    [400, "registration_consent_unrecognized"],
    [400, "unknown"],
    [500, "unknown"],
  ] as const)("redacts non-contract Identity failures (%s, %s)", async (status, code) => {
    const services = createServices();
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => {
        throw identityError(status, { error: { code, message: "secret source message" } });
      }),
      enablePasswordCredential: vi.fn(),
    });

    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders(`203.0.115.${220 + status}`),
      body: JSON.stringify({ email: `unknown-${status}-${code}@chasesets.test`, displayName: "Unknown Contract" }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
    expect(body).not.toContain("secret source message");
  });

  it("returns the waitlist path when registration has no pending invitation", async () => {
    const services = createServices();
    services.registrationAdmission = {
      mode: "invitation",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
    };
    const app = buildApp(services);

    const response = await app.request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.10"),
      body: JSON.stringify({
        email: "new.user@chasesets.test",
        displayName: "New User",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "registration_admission_required",
        waitlistPath: "/#waitlist-form",
      },
    });
    expect(mockCreateIdentityAuthRequestClient).not.toHaveBeenCalled();
  });

  it("allows a pending invitation email to register without consuming invitation acceptance", async () => {
    const services = createServices();
    services.registrationAdmission = {
      mode: "invitation",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
    };
    services.identity.findPendingInvitationByEmail.mockResolvedValue({
      invitation_id: "ivt_wave_1",
      account_id: "acc_wave",
      email: "new.user@chasesets.test",
      role_key: "owner",
      status: "pending",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      accepted_by_user_id: null,
      invited_by_user_id: "usr_inviter",
      updated_at: new Date().toISOString(),
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => ({
        userId: "usr_new",
        accountId: "acc_new",
        membershipId: "mbr_new",
      })),
      enablePasswordCredential: vi.fn(),
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_new",
      sessionToken: "session_token",
      session: { session_id: "ses_new", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.11"),
      body: JSON.stringify({
        email: "New.User@ChaseSets.test",
        displayName: "New User",
      }),
    });

    expect(response.status).toBe(201);
    expect(services.identity.findPendingInvitationByEmail).toHaveBeenCalledWith("new.user@chasesets.test");
  });

  it("does not qualify a non-wave pending invitation for founders cohort access", async () => {
    const services = createServices();
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
    const createPersonalIdentity = vi.fn(async () => ({
      userId: "usr_support_invite",
      accountId: "acc_support_invite",
      membershipId: "mbr_support_invite",
    }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({ createPersonalIdentity, enablePasswordCredential: vi.fn() });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_support_invite",
      sessionId: "ses_support_invite",
      sessionToken: "session_token",
      session: { session_id: "ses_support_invite", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });

    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.111"),
      body: JSON.stringify({ email: "support-invite@chasesets.test", displayName: "Support Invite" }),
    });

    expect(response.status).toBe(201);
    expect(createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ email: "support-invite@chasesets.test", foundersBetaAccessStartedAt: undefined }),
    );
  });

  it("allows a Public Presence beta admission before checking team invitations", async () => {
    const services = createServices();
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
    const createPersonalIdentity = vi.fn(async () => ({
      userId: "usr_wave",
      accountId: "acc_wave",
      membershipId: "mbr_wave",
    }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({ createPersonalIdentity, enablePasswordCredential: vi.fn() });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_wave",
      sessionId: "ses_wave",
      sessionToken: "session_token",
      session: { session_id: "ses_wave", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });

    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.12"),
      body: JSON.stringify({ email: "wave@chasesets.test", displayName: "Wave User" }),
    });

    expect(response.status).toBe(201);
    expect(services.identity.findPendingInvitationByEmail).not.toHaveBeenCalled();
    expect(createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ email: "wave@chasesets.test", foundersBetaAccessStartedAt: expect.any(String) }),
    );
  });

  it("lets dev and test profiles use explicit open registration mode", async () => {
    const services = createServices();
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => ({
        userId: "usr_new",
        accountId: "acc_new",
        membershipId: "mbr_new",
      })),
      enablePasswordCredential: vi.fn(),
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_new",
      sessionToken: "session_token",
      session: { session_id: "ses_new", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.12"),
      body: JSON.stringify({
        email: "new.user@chasesets.test",
        displayName: "New User",
      }),
    });

    expect(response.status).toBe(201);
    expect(services.identity.findPendingInvitationByEmail).not.toHaveBeenCalled();
  });

  it("rate limits registration before admission screening", async () => {
    const services = createServices();
    services.registrationAdmission = {
      mode: "invitation",
      disposableEmailMode: "enforce",
      disposableEmailDomains: ["mailinator.com"],
    };
    const app = buildApp(services);
    const request = {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.13"),
      body: JSON.stringify({
        email: "new.user@chasesets.test",
        displayName: "New User",
      }),
    };

    expect((await app.request("/register", request)).status).toBe(403);
    expect((await app.request("/register", request)).status).toBe(403);
    expect((await app.request("/register", request)).status).toBe(403);
    services.identity.findPendingInvitationByEmail.mockClear();

    const rateLimitedResponse = await app.request("/register", request);

    expect(rateLimitedResponse.status).toBe(429);
    await expect(rateLimitedResponse.json()).resolves.toMatchObject({
      error: { code: "rate_limited", surface: "auth.register.ip" },
    });
    expect(services.identity.findPendingInvitationByEmail).not.toHaveBeenCalled();
  });

  it("rejects disposable email domains when enforcement is enabled", async () => {
    const services = createServices();
    const app = buildApp(services);

    const response = await app.request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.14"),
      body: JSON.stringify({
        email: "new.user@mailinator.com",
        displayName: "New User",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "disposable_email_domain",
        domain: "mailinator.com",
      },
    });
  });

  it("allows disposable domains in log-only mode", async () => {
    const services = createServices();
    const observer = { record: vi.fn() };
    services.registrationAdmission = {
      mode: "open",
      disposableEmailMode: "log-only",
      disposableEmailDomains: ["mailinator.com"],
      screeningObserver: observer,
    };
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () => ({
        userId: "usr_new",
        accountId: "acc_new",
        membershipId: "mbr_new",
      })),
      enablePasswordCredential: vi.fn(),
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_new",
      sessionToken: "session_token",
      session: { session_id: "ses_new", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.15"),
      body: JSON.stringify({
        email: "new.user@mailinator.com",
        displayName: "New User",
      }),
    });

    expect(response.status).toBe(201);
    expect(observer.record).toHaveBeenCalledWith({
      decision: "log-only",
      emailDomain: "mailinator.com",
      reason: "disposable-email-domain",
    });
  });

  it("writes the registered identity into the Auth mirrors before returning a session", async () => {
    const services = createServices();
    const identitySource = {
      sourceContextName: "identity",
      maxGlobalPosition: "51",
      eventIds: ["evt_identity_51"],
    } as const satisfies SourceCommitPosition;
    const credentialSource = {
      sourceContextName: "identity",
      maxGlobalPosition: "53",
      eventIds: ["evt_identity_53"],
    } as const satisfies SourceCommitPosition;
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () =>
        withCommandReceipt(
          {
            userId: "usr_new",
            accountId: "acc_new",
            membershipId: "mbr_new",
          },
          identitySource,
        ),
      ),
      enablePasswordCredential: vi.fn(async () =>
        withCommandReceipt(
          {
            ok: true,
            userId: "usr_new",
            snapshots: [],
          },
          credentialSource,
        ),
      ),
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_new",
      sessionToken: "session_token",
      session: { session_id: "ses_new", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.16"),
      body: JSON.stringify({
        email: " New.User@ChaseSets.test ",
        password: "correct horse battery staple",
        displayName: "New User",
      }),
    });

    expect(response.status).toBe(201);
    expect(decodeCommitReceipt(response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "53",
        eventIds: ["evt_identity_51", "evt_identity_53"],
      },
    ]);
    const body = await response.json();
    expect(body).toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
      accountId: "acc_new",
    });
    expect(body).not.toHaveProperty("commandReceipt");
    expect(JSON.stringify(body)).not.toContain("commandReceipt");

    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth_identity_users"),
      expect.arrayContaining(["usr_new", "New User", "new.user@chasesets.test"]),
    );
    const userMirrorCall = services.db.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO auth_identity_users"),
    );
    expect(JSON.parse(String(userMirrorCall?.[1]?.[6]))).toMatchObject([
      {
        type: "email",
        value: "new.user@chasesets.test",
      },
    ]);
    expect(JSON.parse(String(userMirrorCall?.[1]?.[7]))).toEqual(["password"]);
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth_identity_user_emails"),
      expect.arrayContaining(["new.user@chasesets.test", "usr_new"]),
    );
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth_identity_user_memberships"),
      expect.arrayContaining(["mbr_new", "usr_new", "acc_new", "owner"]),
    );
    const membershipMirrorCall = services.db.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO auth_identity_user_memberships"),
    );
    expect(JSON.parse(String(membershipMirrorCall?.[1]?.[4]))).toContain("listings.view");
    expect(JSON.parse(String(membershipMirrorCall?.[1]?.[4]))).toEqual(
      expect.arrayContaining(["pricing.view", "pricing.manage"]),
    );
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: "usr_new",
        accountId: "acc_new",
        membershipsOverride: [
          expect.objectContaining({
            membershipId: "mbr_new",
            accountId: "acc_new",
            roleKey: "owner",
            rolePermissions: expect.arrayContaining(["pricing.view", "pricing.manage"]),
            status: "active",
          }),
        ],
      }),
    );
  });

  it("forwards the caller-supplied registration consent submission to the identity constructor", async () => {
    const services = createServices();
    const createPersonalIdentity = vi.fn(async () => ({
      userId: "usr_consent",
      accountId: "acc_consent",
      membershipId: "mbr_consent",
    }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({ createPersonalIdentity, enablePasswordCredential: vi.fn() });
    mockStartInteractiveAuth.mockResolvedValue({ type: "session-started", sessionToken: "session_token" });

    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.201"),
      body: JSON.stringify({
        email: "consent@chasesets.test",
        displayName: "Consent Caller",
        registrationConsent: SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION,
      }),
    });

    expect(response.status).toBe(201);
    expect(createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ registrationConsent: SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION }),
    );
  });

  it("relays Identity's rejection when a registration arrives without a resolution", async () => {
    const services = createServices();
    const createPersonalIdentity = vi.fn(async () => {
      throw Object.assign(new Error("rejected"), {
        status: 400,
        body: {
          error: {
            code: "registration_consent_not_server_minted",
            reason: "absent",
            message: "A server-minted registration consent resolution is required.",
          },
        },
      });
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({ createPersonalIdentity, enablePasswordCredential: vi.fn() });

    const response = await buildApp(services).request("/register", {
      method: "POST",
      headers: registrationRequestHeaders("203.0.113.202"),
      body: JSON.stringify({ email: "no-consent@chasesets.test", displayName: "No Consent" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_consent_not_server_minted", reason: "absent" },
    });
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  // The parked review defeated a source-syntax caller check with ordinary code.
  // Each shape below is re-run against this boundary and lands on the same
  // rejection for the same reason: nothing accompanied the registration that
  // only the server could have minted. They are not three cases.
  describe("parked evasions produce one violation for one reason", () => {
    function registrationConsentRejection() {
      return Object.assign(new Error("rejected"), {
        status: 400,
        body: {
          error: {
            code: "registration_consent_not_server_minted",
            reason: "absent",
            message: "A server-minted registration consent resolution is required.",
          },
        },
      });
    }

    function buildRejectingApp() {
      const services = createServices();
      mockCreateIdentityAuthRequestClient.mockReturnValue({
        createPersonalIdentity: vi.fn(async () => {
          throw registrationConsentRejection();
        }),
        enablePasswordCredential: vi.fn(),
      });
      return { app: buildApp(services), services };
    }

    it("rejects a destructured raw auth client with the same code as an absent submission", async () => {
      const { app } = buildRejectingApp();
      // Evasion A: never name the canonical client at the call site.
      const { register } = createAuthApiClient({
        baseUrl: "https://marketplace.test",
        fetch: (async (input: URL | RequestInfo, init?: RequestInit) =>
          app.request(String(input), {
            ...init,
            headers: registrationRequestHeaders("203.0.113.210"),
          })) as typeof globalThis.fetch,
      });

      await expect(
        register({ email: "evasion-a@chasesets.test", displayName: "Evasion A", password: "hunter2hunter2" }),
      ).rejects.toMatchObject({
        status: 400,
        body: { error: { code: "registration_consent_not_server_minted", reason: "absent" } },
      });
      expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
    });

    it("rejects a split-string route URL with the same code as an absent submission", async () => {
      const { app } = buildRejectingApp();
      // Evasion B: never write the route as one literal.
      const route = "/regi" + "ster";

      const response = await app.request(route, {
        method: "POST",
        headers: registrationRequestHeaders("203.0.113.211"),
        body: JSON.stringify({ email: "evasion-b@chasesets.test", displayName: "Evasion B" }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "registration_consent_not_server_minted", reason: "absent" },
      });
      expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
    });

    it("rejects a caller-local impostor binder with the same code as an absent submission", async () => {
      const services = createServices();
      const impostorRejection = Object.assign(new Error("rejected"), {
        status: 400,
        body: {
          error: {
            code: "registration_consent_not_server_minted",
            reason: "signature-invalid",
            message: "The registration consent resolution signature does not verify.",
          },
        },
      });
      mockCreateIdentityAuthRequestClient.mockReturnValue({
        createPersonalIdentity: vi.fn(async () => {
          throw impostorRejection;
        }),
        enablePasswordCredential: vi.fn(),
      });
      // Evasion D: a caller-local binder with the canonical name, returning a
      // plausibly-shaped unsigned object.
      const registrationConsentSubmission = () => ({
        resolution: {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: new Date().toISOString(),
          signature: "locally-minted",
        },
        affirmed: true,
      });

      const response = await buildApp(services).request("/register", {
        method: "POST",
        headers: registrationRequestHeaders("203.0.113.212"),
        body: JSON.stringify({
          email: "evasion-d@chasesets.test",
          displayName: "Evasion D",
          registrationConsent: registrationConsentSubmission(),
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "registration_consent_not_server_minted" },
      });
      expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
    });
  });
});
