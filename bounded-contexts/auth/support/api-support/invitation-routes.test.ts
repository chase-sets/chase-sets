import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import {
  SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION,
  withRegistrationConsentResolution,
} from "./registration-consent-test-support";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  encodeFreshWriteReceipt,
  type FreshWriteReceipt,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  attachResponseMetadata,
  decodeCommitReceipt,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";
import * as journey from "../../features/invitation-acceptance/api/journey";
import { InvitationAttemptError } from "../../features/invitation-acceptance/domain/attempt";
import type { AuthServices } from "../runtime-support/services";
import { createInvitationProjectionFreshnessWaiter } from "../runtime-support/invitation-projection-freshness";
import { registerInvitationRoutes } from "./invitation-routes";
import type { AuthApiEnv } from "./support";
import {
  SAME_SITE_TEST_ORIGIN,
  UNSAFE_AUTH_PATHS,
  VALID_AUTH_PATHS,
} from "../auth-support/same-site-path.test-support";
import * as sameSitePaths from "../auth-support/same-site-path";

function invitationFreshWriteHeader(maxGlobalPosition: string): Record<string, string> {
  const receipt: FreshWriteReceipt = {
    observedAtMs: Date.now(),
    sources: [{ sourceContextName: "identity", maxGlobalPosition, eventIds: [`evt_${maxGlobalPosition}`] }],
  };
  return { [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt(receipt) };
}

const rateLimiters = vi.hoisted(() => new Map<string, import("@chase-sets/http/rate-limit").InMemoryRateLimiter>());
vi.mock("@chase-sets/http/rate-limit", async (original) => {
  const actual = await original<typeof import("@chase-sets/http/rate-limit")>();
  return {
    ...actual,
    createConfiguredInMemoryRateLimiter: (
      surface: string,
      defaults: import("@chase-sets/http/rate-limit").RateLimitRule,
    ) => {
      const limiter = actual.createInMemoryRateLimiter({ ...defaults, disabled: false, keyPrefix: surface });
      rateLimiters.set(surface, limiter);
      return limiter;
    },
  };
});
beforeEach(() => {
  for (const limiter of rateLimiters.values()) limiter.clear();
});

const {
  mockConsumeChallenge,
  mockCreateIdentityAuthRequestClient,
  mockGetPasswordCredentialByUserId,
  mockStartInteractiveAuth,
  mockUpsertPasskeyCredential,
  mockUpsertPasswordCredential,
  mockVerifyPasskeyRegistration,
} = vi.hoisted(() => ({
  mockConsumeChallenge: vi.fn(),
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockGetPasswordCredentialByUserId: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
  mockUpsertPasskeyCredential: vi.fn(),
  mockUpsertPasswordCredential: vi.fn(),
  mockVerifyPasskeyRegistration: vi.fn(),
}));

vi.mock("../auth-support/store", () => ({
  consumeChallenge: mockConsumeChallenge,
  getPasswordCredentialByUserId: mockGetPasswordCredentialByUserId,
  upsertPasskeyCredential: mockUpsertPasskeyCredential,
  upsertPasswordCredential: mockUpsertPasswordCredential,
}));

vi.mock("../auth-support/webauthn", () => ({ verifyPasskeyRegistration: mockVerifyPasskeyRegistration }));

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
        trace: { traceId: "trace_invitation" },
      },
    ),
    routes: (app) => {
      registerInvitationRoutes(app, services as AuthServices);
      app.onError(errorHandler);
    },
  });
}

function createServices() {
  mockGetPasswordCredentialByUserId.mockResolvedValue(null);
  return {
    db: {
      query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })),
    },
    auth: {
      issueOpaqueToken: vi.fn(() => "invite_token"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
      verifySecret: vi.fn((value: string, hash: string) => hash === `hashed:${value}`),
      hashPassword: vi.fn(async (value: string) => `password:${value}`),
      verifyPassword: vi.fn(async (value: string, hash: string) => ({ valid: hash === `hashed:${value}` })),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getInvitation: vi.fn(async (_invitationId: string) => ({
        invitation_id: "ivt_1",
        account_id: "acc_invited",
        email: "seller@example.com",
        role_key: "viewer",
        status: "pending",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        accepted_by_user_id: null,
        invited_by_user_id: "usr_inviter",
        account_display_name: "Competitive Cards",
        invited_by_display_name: "Avery Collector",
        updated_at: new Date().toISOString(),
      })),
      getUser: vi.fn(async () => ({ user_id: "usr_new" })),
      getUserByEmail: vi.fn(async (_email: string): Promise<{ user_id: string } | null> => null),
    },
    notificationOutbox: {
      enqueueNotification: vi.fn(async (_input: { message: { templateData: Record<string, unknown> } }) => undefined),
    },
  };
}

function createIdentityMutations() {
  return {
    issueInvitationAcceptanceToken: vi.fn(async () => ({
      invitationId: "ivt_1",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      snapshots: [],
    })),
    verifyInvitationAcceptanceToken: vi.fn(async () => ({
      invitationId: "ivt_1",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    createPersonalIdentity: vi.fn(async () => ({
      userId: "usr_new",
      accountId: "acc_personal",
      membershipId: "mbr_personal",
      snapshots: [],
    })),
    acceptInvitationForUser: vi.fn(async () => ({
      membershipId: "mbr_invited",
      snapshots: [],
    })),
    verifyEmailContactMethod: vi.fn(async () => ({
      ok: true,
      userId: "usr_new",
      snapshots: [],
    })),
    enablePasswordCredential: vi.fn(async () => ({
      ok: true,
      userId: "usr_new",
      snapshots: [],
    })),
    registerPasskeyCredential: vi.fn(async () => ({
      ok: true,
      userId: "usr_new",
      snapshots: [],
    })),
  };
}

useMockReset();

describe("invitation auth routes", () => {
  it("checks the final invitation origin before appending a token even if validation regresses", async () => {
    const guard = vi.spyOn(sameSitePaths, "getSafeSameSitePath").mockReturnValue("/\\outside.example.test/collect");
    try {
      const services = createServices();
      mockCreateIdentityAuthRequestClient.mockReturnValue(createIdentityMutations());
      const response = await buildApp(services).request(
        `${SAME_SITE_TEST_ORIGIN}/invitations/acceptance-link/request`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invitationId: "ivt_1" }),
        },
      );
      expect(response.status).toBe(200);
      const message = services.notificationOutbox.enqueueNotification.mock.calls[0]![0].message;
      const url = new URL(String(message.templateData.invitationLink));
      expect(url.origin).toBe(SAME_SITE_TEST_ORIGIN);
      expect(url.pathname).toBe("/invite/ivt_1");
      expect(url.searchParams.get("token")).toBe("invite_token");
    } finally {
      guard.mockRestore();
    }
  });

  it.each([...UNSAFE_AUTH_PATHS, ...VALID_AUTH_PATHS])(
    "tokenized links remain same-origin: invitation %j",
    async (path) => {
      const services = createServices();
      const mutations = createIdentityMutations();
      mockCreateIdentityAuthRequestClient.mockReturnValue(mutations);
      const response = await buildApp(services).request(
        `${SAME_SITE_TEST_ORIGIN}/invitations/acceptance-link/request`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invitationId: "ivt_1", landingPath: path }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("token");
      const message = services.notificationOutbox.enqueueNotification.mock.calls[0]![0].message;
      const url = new URL(String(message.templateData.invitationLink));
      const expected = new URL(VALID_AUTH_PATHS.includes(path) ? path : "/invite/ivt_1", SAME_SITE_TEST_ORIGIN);
      expect(url.origin).toBe(SAME_SITE_TEST_ORIGIN);
      expect(url.pathname).toBe(expected.pathname);
      expect(url.hash).toBe(expected.hash);
      expect(url.searchParams.get("token")).toBe("invite_token");
      expect(url.searchParams.get("invitationId")).toBe("ivt_1");
      for (const [key, value] of expected.searchParams) expect(url.searchParams.get(key)).toBe(value);
      expect(mutations.issueInvitationAcceptanceToken).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: "hashed:invite_token" }),
      );
    },
  );

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
    const services = createServices();
    const mutations = createIdentityMutations();
    mutations.createPersonalIdentity.mockRejectedValue(identityError(status, body));
    mockCreateIdentityAuthRequestClient.mockReturnValue(mutations);
    return buildApp(services).request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        token: "synthetic-secret",
        password: "synthetic-password",
      }),
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

  const attemptId = "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea";
  const keyedRequest = {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": attemptId },
    body: JSON.stringify({
      attemptId,
      invitationId: "ivt_1",
      token: "synthetic-secret",
      password: "synthetic-password",
    }),
  };
  it.each(consentRejections)("PROBE F2 keyed attempt relays $code consent rejection", async (rejection) => {
    const accept = vi
      .spyOn(journey, "acceptInvitationAttempt")
      .mockRejectedValueOnce(identityError(400, { error: rejection }));
    try {
      const response = await buildApp(createServices()).request("/invitations/accept", keyedRequest);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: rejection });
    } finally {
      accept.mockRestore();
    }
  });
  it.each([
    ["auth.invitation.accept.ip", "local", 10],
    ["auth.invitation.accept.identifier", "invitation:ivt_1", 5],
  ] as const)("N3 status lookup preserves %s entry limits", async (surface, key, max) => {
    const limiter = rateLimiters.get(surface)!;
    for (let count = 0; count < max; count++) limiter.check(key);
    const lookup = vi.spyOn(journey, "lookupInvitationAttempt");
    try {
      const response = await buildApp(createServices()).request("/invitations/acceptance-status", keyedRequest);
      expect(response.status).toBe(429);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });
  it("F3 keyed ambiguous lock refusal is 503, not conflict", async () => {
    const accept = vi
      .spyOn(journey, "acceptInvitationAttempt")
      .mockRejectedValueOnce(new InvitationAttemptError("invitation_attempt_ambiguous"));
    try {
      const response = await buildApp(createServices()).request("/invitations/accept", keyedRequest);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "invitation_attempt_ambiguous" } });
    } finally {
      accept.mockRestore();
    }
  });
  it("F5 unexpected status faults carry a server failure signal without secrets", async () => {
    const lookup = vi.spyOn(journey, "lookupInvitationAttempt").mockRejectedValueOnce(new Error("synthetic-secret"));
    try {
      const response = await buildApp(createServices()).request("/invitations/acceptance-status", keyedRequest);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await response.text()).not.toContain("synthetic-secret");
    } finally {
      lookup.mockRestore();
    }
  });
  it.each([403, 404])("F5 expected Identity %s refusals remain uniform nonsecret status responses", async (status) => {
    const lookup = vi
      .spyOn(journey, "lookupInvitationAttempt")
      .mockRejectedValueOnce({ status, body: { secret: "synthetic-secret" } });
    try {
      const response = await buildApp(createServices()).request("/invitations/acceptance-status", keyedRequest);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ type: "ambiguous" });
      expect(response.headers.get("Set-Cookie")).toBeNull();
    } finally {
      lookup.mockRestore();
    }
  });
  it("F6 first keyed Session response carries Identity commit receipts, without exposing sources", async () => {
    const sources = [{ sourceContextName: "identity", maxGlobalPosition: "42", eventIds: ["evt_acceptance"] }];
    const source = attachResponseMetadata(
      { snapshots: [{ aggregate: "membership", id: "mbr_invited", version: 1, status: "active" }] },
      new Response(null, {
        headers: {
          "Chase-Sets-Consistency": "eventual",
          [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt(sources),
        },
      }),
    );
    const accept = vi.spyOn(journey, "acceptInvitationAttempt").mockResolvedValueOnce({
      type: "session-started",
      sessionToken: "synthetic-first-secret",
      mutationSources: [source],
    } as Awaited<ReturnType<typeof journey.acceptInvitationAttempt>>);
    try {
      const response = await buildApp(createServices()).request("/invitations/accept", keyedRequest);
      expect(response.status).toBe(200);
      expect(decodeCommitReceipt(response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual(sources);
      const body = await response.json();
      expect(body).toMatchObject({ type: "session-started", sessionToken: "synthetic-first-secret" });
      expect(body).not.toHaveProperty("mutationSources");
    } finally {
      accept.mockRestore();
    }
  });
  it.each([
    ["auth.invitation.accept.ip", "local", 10],
    ["auth.invitation.accept.identifier", "invitation:ivt_1", 5],
  ] as const)("invitation-acceptance-attempt-binding preserves %s before journey work", async (surface, key, max) => {
    const services = createServices();
    const limiter = rateLimiters.get(surface)!;
    for (let count = 0; count < max; count++) limiter.check(key);
    const check = vi.spyOn(limiter, "check");
    try {
      const attemptId = "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea";
      const response = await buildApp(services).request("https://marketplace.test/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attemptId },
        body: JSON.stringify({
          attemptId,
          invitationId: "ivt_1",
          token: "synthetic-token",
          password: "synthetic-password",
        }),
      });
      expect(check).toHaveBeenCalledWith(key);
      expect(response.status).toBe(429);
      expect(mockCreateIdentityAuthRequestClient).not.toHaveBeenCalled();
      expect(services.db.query).not.toHaveBeenCalled();
      expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
  });
  it("invitation-acceptance-attempt-binding: refuses disagreement before any owner or Session command", async () => {
    const services = createServices();
    const mutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(mutations);
    const response = await buildApp(services).request("https://marketplace.test/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "fe477381-15cc-4ca8-9a40-a004a01ee107" },
      body: JSON.stringify({
        attemptId: "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea",
        invitationId: "ivt_1",
        token: "invitation-secret",
        password: "password-secret",
      }),
    });
    expect(response.status).toBe(400);
    expect(mutations.verifyInvitationAcceptanceToken).not.toHaveBeenCalled();
    expect(mutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(mutations.acceptInvitationForUser).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
    expect(await response.text()).not.toMatch(/invitation-secret|password-secret/);
  });
  it("emails an invitation acceptance token without returning the bearer token", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("https://marketplace.test/invitations/acceptance-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        landingPath: "/accept-invitation",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      invitationId: "ivt_1",
      expiresAt: expect.any(String),
    });
    expect(body).not.toHaveProperty("token");
    expect(identityMutations.issueInvitationAcceptanceToken).toHaveBeenCalledWith(
      expect.objectContaining({
        invitationId: "ivt_1",
        tokenHash: "hashed:invite_token",
      }),
    );
    expect(services.notificationOutbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "auth.invitation-acceptance-link.requested",
          channels: [
            expect.objectContaining({
              channel: "email",
              to: [{ email: "seller@example.com" }],
            }),
          ],
          templateData: {
            invitationLink: expect.stringContaining("token=invite_token"),
            accountName: "Competitive Cards",
            roleLabel: "Viewer",
          },
        }),
      }),
    );
    const message = services.notificationOutbox.enqueueNotification.mock.calls[0]?.[0].message;
    expect(String(message?.templateData.invitationLink)).toContain("invitationId=ivt_1");
  });

  it("waits for the forwarded invitation projection version before reading, then emails", async () => {
    const services = createServices();
    const awaitInvitationProjectionFreshness = vi.fn(async (_receipt: FreshWriteReceipt) => undefined);
    const withWaiter = { ...services, awaitInvitationProjectionFreshness };
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(withWaiter);

    const response = await app.request("https://marketplace.test/invitations/acceptance-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.10",
        ...invitationFreshWriteHeader("42"),
      },
      body: JSON.stringify({ invitationId: "ivt_wait" }),
    });

    expect(response.status).toBe(200);
    // The wait consumed the forwarded receipt at its target version...
    expect(awaitInvitationProjectionFreshness).toHaveBeenCalledTimes(1);
    expect(awaitInvitationProjectionFreshness.mock.calls[0][0]).toMatchObject({
      sources: [{ sourceContextName: "identity", maxGlobalPosition: "42" }],
    });
    // ...and it ran before the invitation projection read.
    expect(awaitInvitationProjectionFreshness.mock.invocationCallOrder[0]).toBeLessThan(
      services.identity.getInvitation.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("still reads and emails without a forwarded receipt (unchanged behavior)", async () => {
    const services = createServices();
    const awaitInvitationProjectionFreshness = vi.fn(async (_receipt: FreshWriteReceipt) => undefined);
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp({ ...services, awaitInvitationProjectionFreshness });

    const response = await app.request("https://marketplace.test/invitations/acceptance-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify({ invitationId: "ivt_nowait" }),
    });

    expect(response.status).toBe(200);
    expect(awaitInvitationProjectionFreshness).not.toHaveBeenCalled();
    expect(services.identity.getInvitation).toHaveBeenCalledTimes(1);
  });

  it("falls back to emailing when the invitation projection never catches up within the bound", async () => {
    const services = createServices();
    // Real bounded waiter whose checkpoint never reaches the forwarded version.
    const awaitInvitationProjectionFreshness = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition: async () => "1",
      timeoutMs: 40,
      pollIntervalMs: 1,
    });
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp({ ...services, awaitInvitationProjectionFreshness });

    const response = await app.request("https://marketplace.test/invitations/acceptance-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.12",
        ...invitationFreshWriteHeader("999"),
      },
      body: JSON.stringify({ invitationId: "ivt_fallback" }),
    });

    // Graceful: the bounded wait times out, the handler still reads the pending
    // invitation and issues the acceptance email rather than failing.
    expect(response.status).toBe(200);
    expect(services.identity.getInvitation).toHaveBeenCalledTimes(1);
    expect(services.notificationOutbox.enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it("completes the invite, email link, acceptance, and invited-account session journey", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    identityMutations.issueInvitationAcceptanceToken.mockResolvedValue({
      invitationId: "ivt_journey",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      snapshots: [],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_journey",
      sessionToken: "session_token",
      session: { session_id: "ses_journey", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const emailResponse = await app.request("https://marketplace.test/invitations/acceptance-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.80" },
      body: JSON.stringify({ invitationId: "ivt_journey" }),
    });
    expect(emailResponse.status).toBe(200);
    const message = services.notificationOutbox.enqueueNotification.mock.calls[0]?.[0].message;
    const invitationLink = new URL(String(message?.templateData.invitationLink));

    const acceptanceResponse = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.80" },
      body: JSON.stringify({
        invitationId: invitationLink.searchParams.get("invitationId"),
        token: invitationLink.searchParams.get("token"),
        password: "correct horse battery staple",
      }),
    });

    expect(invitationLink.pathname).toBe("/invite/ivt_journey");
    const invitedPermissions = mockStartInteractiveAuth.mock.calls.at(-1)?.[1].membershipsOverride[0].rolePermissions;
    expect(invitedPermissions).not.toContain("pricing.manage");
    expect(acceptanceResponse.status).toBe(200);
    await expect(acceptanceResponse.json()).resolves.toMatchObject({
      type: "session-started",
      invitationId: "ivt_journey",
      membershipId: "mbr_invited",
    });
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        accountId: "acc_invited",
        membershipsOverride: [
          expect.objectContaining({ roleKey: "viewer", rolePermissions: expect.arrayContaining(["pricing.view"]) }),
        ],
      }),
    );
  });

  it("inspects a valid pending invitation for the recipient page", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: "ivt_1", token: "invite_token" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "pending",
      invitationId: "ivt_1",
      email: "seller@example.com",
      accountName: "Competitive Cards",
      invitedByName: "Avery Collector",
      roleLabel: "Viewer",
    });
    expect(identityMutations.verifyInvitationAcceptanceToken).toHaveBeenCalledWith({
      invitationId: "ivt_1",
      acceptanceTokenHash: "hashed:invite_token",
    });
  });

  it.each([
    ["accepted", "accepted"],
    ["cancelled", "revoked"],
    ["expired", "expired"],
  ] as const)("reports %s invitations as %s", async (storedStatus, publicStatus) => {
    const services = createServices();
    services.identity.getInvitation.mockResolvedValue({
      ...(await services.identity.getInvitation("ivt_1"))!,
      status: storedStatus,
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(createIdentityMutations());
    const response = await buildApp(services).request("/invitations/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: "ivt_1", token: "invite_token" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: publicStatus });
  });

  it("rejects invitation id alone without provisioning a user or issuing a session", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        password: "correct horse battery staple",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invitation acceptance token is invalid or expired.",
    });
    expect(identityMutations.verifyInvitationAcceptanceToken).not.toHaveBeenCalled();
    expect(identityMutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(identityMutations.enablePasswordCredential).not.toHaveBeenCalled();
    expect(mockUpsertPasswordCredential).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("rejects invalid invitation tokens before provisioning a user", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    identityMutations.verifyInvitationAcceptanceToken.mockRejectedValue({ status: 403 });
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        token: "wrong_token",
        password: "correct horse battery staple",
      }),
    });

    expect(response.status).toBe(401);
    expect(identityMutations.verifyInvitationAcceptanceToken).toHaveBeenCalledWith({
      invitationId: "ivt_1",
      acceptanceTokenHash: "hashed:wrong_token",
    });
    expect(identityMutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(identityMutations.enablePasswordCredential).not.toHaveBeenCalled();
    expect(mockUpsertPasswordCredential).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("rejects an expired invitation even when token verification succeeds", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    identityMutations.verifyInvitationAcceptanceToken.mockResolvedValue({
      invitationId: "ivt_1",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        token: "invite_token",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invitation acceptance token is invalid or expired.",
    });
    expect(identityMutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(identityMutations.acceptInvitationForUser).not.toHaveBeenCalled();
    expect(identityMutations.verifyEmailContactMethod).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("verifies an existing user's password before consuming the invitation", async () => {
    const services = createServices();
    services.identity.getUserByEmail.mockResolvedValue({ user_id: "usr_existing" });
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockGetPasswordCredentialByUserId.mockResolvedValue({
      credential_id: "crd_existing",
      user_id: "usr_existing",
      secret_hash: "hashed:existing password",
    });

    const response = await buildApp(services).request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.91" },
      body: JSON.stringify({
        invitationId: "ivt_existing_password",
        token: "invite_token",
        password: "wrong password",
      }),
    });

    expect(response.status).toBe(401);
    expect(identityMutations.acceptInvitationForUser).not.toHaveBeenCalled();
    expect(identityMutations.enablePasswordCredential).not.toHaveBeenCalled();
    expect(mockUpsertPasswordCredential).not.toHaveBeenCalled();
  });

  it("accepts a valid emailed token once and rejects replay", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const first = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.101" },
      body: JSON.stringify({
        invitationId: "ivt_valid_once",
        token: "invite_token",
        password: "correct horse battery staple",
      }),
    });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
      invitationId: "ivt_valid_once",
      membershipId: "mbr_invited",
    });
    expect(identityMutations.verifyInvitationAcceptanceToken).toHaveBeenCalledWith({
      invitationId: "ivt_valid_once",
      acceptanceTokenHash: "hashed:invite_token",
    });
    expect(identityMutations.acceptInvitationForUser).toHaveBeenCalledWith({
      invitationId: "ivt_valid_once",
      userId: "usr_new",
      acceptanceTokenHash: "hashed:invite_token",
    });
    expect(identityMutations.verifyEmailContactMethod).toHaveBeenCalledWith({
      userId: "usr_new",
      email: "seller@example.com",
    });
    expect(identityMutations.enablePasswordCredential.mock.invocationCallOrder[0]).toBeGreaterThan(
      identityMutations.acceptInvitationForUser.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockUpsertPasswordCredential).toHaveBeenCalledWith(
      services.db,
      expect.objectContaining({
        userId: "usr_new",
        secretHash: "password:correct horse battery staple",
      }),
    );
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: "usr_new",
        accountId: "acc_invited",
        authenticationMethod: "password",
        membershipsOverride: [
          expect.objectContaining({
            membershipId: "mbr_invited",
            accountId: "acc_invited",
            roleKey: "viewer",
            status: "active",
          }),
        ],
      }),
    );

    identityMutations.verifyInvitationAcceptanceToken.mockRejectedValueOnce({ status: 403 });
    const second = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.101" },
      body: JSON.stringify({
        invitationId: "ivt_valid_once",
        token: "invite_token",
      }),
    });

    expect(second.status).toBe(401);
  });

  it("registers a passkey while accepting and authenticates into the invited account", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockConsumeChallenge.mockResolvedValue({ email: "seller@example.com", challenge_value: "challenge" });
    mockVerifyPasskeyRegistration.mockResolvedValue({
      externalCredentialId: "external_credential",
      publicKey: "public_key",
      signCount: 0,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_passkey",
      sessionToken: "session_token",
      session: { session_id: "ses_passkey", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });

    const response = await buildApp(services).request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.44" },
      body: JSON.stringify({
        invitationId: "ivt_passkey",
        token: "invite_token",
        challengeId: "cmd_challenge",
        challenge: "challenge",
        webauthnResponse: "response",
      }),
    });

    expect(response.status).toBe(200);
    expect(identityMutations.registerPasskeyCredential).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "usr_new" }),
    );
    expect(mockUpsertPasskeyCredential).toHaveBeenCalledWith(
      services.db,
      expect.objectContaining({ userId: "usr_new", externalCredentialId: "external_credential" }),
    );
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({ accountId: "acc_invited", authenticationMethod: "passkey" }),
    );
  });

  it("forwards the server-minted registration consent submission to the identity constructor", async () => {
    const services = createServices();
    services.identity.getUserByEmail.mockResolvedValue(null);
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockStartInteractiveAuth.mockResolvedValue({ type: "session-started", sessionToken: "session_token" });

    const response = await buildApp(services).request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.201" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        token: "invite_token",
        password: "correct horse battery staple",
      }),
    });

    expect(response.status).toBe(200);
    expect(identityMutations.createPersonalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ registrationConsent: SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION }),
    );
  });
});
