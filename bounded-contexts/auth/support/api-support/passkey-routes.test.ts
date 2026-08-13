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
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  decodeCommitReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import { createAuthServicesFake } from "../auth-support/test-support";
import type { AuthServices } from "../runtime-support/services";
import { passkeyMatchesChallengeUser, registerPasskeyRoutes, resolvePasskeyRegistrationUserId } from "./passkey-routes";
import type { AuthApiEnv } from "./support";

const {
  mockCreateIdentityAuthRequestClient,
  mockCreatePersonalIdentity,
  mockRegisterPasskeyCredential,
  mockVerifyAuthenticationResponse,
  mockVerifyRegistrationResponse,
} = vi.hoisted(() => ({
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockCreatePersonalIdentity: vi.fn(),
  mockRegisterPasskeyCredential: vi.fn(),
  mockVerifyAuthenticationResponse: vi.fn(),
  mockVerifyRegistrationResponse: vi.fn(),
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

vi.mock("@simplewebauthn/server", () => ({
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
}));

function buildApp(services: AuthServices) {
  return createTestApp<AuthApiEnv>({
    actor: createAnonymousTestActor(),
    context: createTestEventStoreContext(createInternalSystemTestActor(), {
      tenantId: "ten_test",
      trace: { traceId: "trc_test" as never },
    }),
    routes: (app) => {
      registerPasskeyRoutes(app, services);
    },
  });
}

function createServices() {
  const db = {
    query: vi.fn(async () => ({ rows: [] })),
  };

  return createAuthServicesFake({
    db,
    auth: {
      issueChallenge: vi.fn(() => "challenge_value"),
      issueOpaqueToken: vi.fn(() => "session_token"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserByEmail: vi.fn(async () => null),
      findPendingInvitationByEmail: vi.fn(async () => null),
      listActiveMembershipsForUser: vi.fn(async () => [
        {
          membershipId: "mbr_1",
          accountId: "acc_new",
          roleKey: "owner",
          status: "active",
          rolePermissions: AUTH_ROLE_PERMISSIONS.owner,
        },
      ]),
    },
    sessions: {
      getSession: vi.fn(async (sessionId: string) => ({
        session_id: sessionId,
        user_id: "usr_new",
        account_id: "acc_new",
        available_account_ids: ["acc_new"],
        authentication_method: "passkey",
        status: "active",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      })),
    },
  });
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

useMockReset(
  mockCreateIdentityAuthRequestClient,
  mockCreatePersonalIdentity,
  mockRegisterPasskeyCredential,
  mockVerifyAuthenticationResponse,
  mockVerifyRegistrationResponse,
);

const registrationResponse = JSON.stringify({
  id: "external_credential",
  rawId: "external_credential",
  type: "public-key",
  response: {
    clientDataJSON: "client_data",
    attestationObject: "attestation",
    transports: ["internal"],
  },
  clientExtensionResults: {},
});

const authenticationResponse = JSON.stringify({
  id: "external_credential",
  rawId: "external_credential",
  type: "public-key",
  response: {
    clientDataJSON: "client_data",
    authenticatorData: "authenticator_data",
    signature: "signature",
  },
  clientExtensionResults: {},
});

function mockVerifiedRegistration() {
  mockVerifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id: "external_credential",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 7,
      },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
    },
  });
}

function mockVerifiedAuthentication() {
  mockVerifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: {
      credentialID: "external_credential",
      newCounter: 8,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
    },
  });
}

describe("passkey route security", () => {
  beforeEach(() => {
    mockVerifiedRegistration();
    mockVerifiedAuthentication();
  });

  it("allows discoverable credentials only when they match the challenged user", () => {
    expect(passkeyMatchesChallengeUser(null, "usr_any")).toBe(false);
    expect(passkeyMatchesChallengeUser("usr_owner", "usr_owner")).toBe(true);
    expect(passkeyMatchesChallengeUser("usr_owner", "usr_other")).toBe(false);
  });

  it("does not let anonymous passkey registration choose a user id", () => {
    expect(
      resolvePasskeyRegistrationUserId({
        actorUserId: null,
        bodyUserId: "usr_victim",
        challengeUserId: null,
      }),
    ).toEqual({ status: "resolved", userId: null });
  });

  it("rejects authenticated passkey registration for another user", () => {
    expect(
      resolvePasskeyRegistrationUserId({
        actorUserId: "usr_owner",
        bodyUserId: "usr_other",
        challengeUserId: null,
      }),
    ).toEqual({ status: "forbidden" });
  });

  it("creates a personal identity, stores the passkey lookup, and starts the first session", async () => {
    const services = createServices();
    const identitySource = {
      sourceContextName: "identity",
      maxGlobalPosition: "61",
      eventIds: ["evt_identity_61"],
    } as const satisfies SourceCommitPosition;
    const credentialSource = {
      sourceContextName: "identity",
      maxGlobalPosition: "63",
      eventIds: ["evt_identity_63"],
    } as const satisfies SourceCommitPosition;
    const dbQuery = vi.mocked(services.db.query);
    dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            challenge_id: "cmd_1",
            purpose: "passkey-register",
            email: "owner@pokebash.example",
            user_id: null,
            challenge_value: "challenge_value",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    mockCreatePersonalIdentity.mockResolvedValue(
      withCommandReceipt(
        {
          userId: "usr_new",
          accountId: "acc_new",
          membershipId: "mbr_new",
        },
        identitySource,
      ),
    );
    mockRegisterPasskeyCredential.mockResolvedValue(
      withCommandReceipt(
        {
          ok: true,
          userId: "usr_new",
          snapshots: [],
        },
        credentialSource,
      ),
    );
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: mockCreatePersonalIdentity,
      registerPasskeyCredential: mockRegisterPasskeyCredential,
    });
    const app = buildApp(services);

    const response = await app.request("/passkeys/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: "cmd_1",
        challenge: "challenge_value",
        displayName: "PokeBash TCG",
        externalCredentialId: "external_credential",
        label: "Passkey",
        webauthnResponse: registrationResponse,
      }),
    });

    expect(response.status).toBe(201);
    expect(decodeCommitReceipt(response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "63",
        eventIds: ["evt_identity_61", "evt_identity_63"],
      },
    ]);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        userId: "usr_new",
        authResult: expect.objectContaining({
          type: "session-started",
          sessionToken: "session_token",
        }),
      }),
    );
    expect(body).not.toHaveProperty("commandReceipt");
    // The exact server-minted resolution reaches the constructor.
    expect(mockCreatePersonalIdentity).toHaveBeenCalledWith({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      registrationConsent: SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION,
    });
    expect(mockRegisterPasskeyCredential).toHaveBeenCalledWith({
      userId: "usr_new",
      credentialId: expect.stringMatching(/^crd_/),
    });
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_passkey_credentials"),
      expect.arrayContaining(["usr_new", "external_credential", "Passkey", "AQID", 7, "multiDevice", true]),
    );
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_passkey_lookup"),
      expect.arrayContaining(["external_credential", "usr_new", "Passkey"]),
    );
    expect(services.sessions.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "StartSession",
          userId: "usr_new",
          accountId: "acc_new",
          availableAccountIds: ["acc_new"],
        }),
      }),
    );
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "challenge_value",
        expectedOrigin: "http://localhost",
        expectedRPID: "localhost",
        expectedType: "webauthn.create",
        requireUserPresence: true,
        requireUserVerification: true,
      }),
    );
  });

  it("rejects passkey sign-in when the WebAuthn assertion is missing", async () => {
    const services = createServices();
    const dbQuery = vi.mocked(services.db.query);
    dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            challenge_id: "cmd_1",
            purpose: "passkey-sign-in",
            email: "owner@pokebash.example",
            user_id: "usr_owner",
            challenge_value: "challenge_value",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            credential_id: "crd_1",
            user_id: "usr_owner",
            external_credential_id: "external_credential",
            label: "Passkey",
            public_key: "AQID",
            sign_count: 7,
            credential_device_type: "multiDevice",
            credential_backed_up: true,
          },
        ],
      });
    const app = buildApp(services);

    const response = await app.request("/passkeys/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: "cmd_1",
        challenge: "challenge_value",
        externalCredentialId: "external_credential",
      }),
    });

    expect(response.status).toBe(401);
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects anonymous sign-in challenges instead of matching any passkey credential", async () => {
    const services = createServices();
    const dbQuery = vi.mocked(services.db.query);
    dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            challenge_id: "cmd_1",
            purpose: "passkey-sign-in",
            email: null,
            user_id: null,
            challenge_value: "challenge_value",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            credential_id: "crd_1",
            user_id: "usr_owner",
            external_credential_id: "external_credential",
            label: "Passkey",
            public_key: "AQID",
            sign_count: 7,
            credential_device_type: "multiDevice",
            credential_backed_up: true,
          },
        ],
      });
    const app = buildApp(services);

    const response = await app.request("/passkeys/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: "cmd_1",
        challenge: "challenge_value",
        externalCredentialId: "external_credential",
        webauthnResponse: authenticationResponse,
      }),
    });

    expect(response.status).toBe(401);
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects assertions whose credential id does not match the stored credential id", async () => {
    const services = createServices();
    const dbQuery = vi.mocked(services.db.query);
    dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            challenge_id: "cmd_1",
            purpose: "passkey-sign-in",
            email: "owner@pokebash.example",
            user_id: "usr_owner",
            challenge_value: "challenge_value",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            credential_id: "crd_1",
            user_id: "usr_owner",
            external_credential_id: "external_credential",
            label: "Passkey",
            public_key: "AQID",
            sign_count: 7,
            credential_device_type: "multiDevice",
            credential_backed_up: true,
          },
        ],
      });
    const app = buildApp(services);

    const response = await app.request("/passkeys/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: "cmd_1",
        challenge: "challenge_value",
        externalCredentialId: "external_credential",
        webauthnResponse: authenticationResponse.replaceAll("external_credential", "other_credential"),
      }),
    });

    expect(response.status).toBe(401);
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects assertions posted from an origin that does not match the request host", async () => {
    const services = createServices();
    const dbQuery = vi.mocked(services.db.query);
    dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            challenge_id: "cmd_1",
            purpose: "passkey-sign-in",
            email: "owner@pokebash.example",
            user_id: "usr_owner",
            challenge_value: "challenge_value",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            credential_id: "crd_1",
            user_id: "usr_owner",
            external_credential_id: "external_credential",
            label: "Passkey",
            public_key: "AQID",
            sign_count: 7,
            credential_device_type: "multiDevice",
            credential_backed_up: true,
          },
        ],
      });
    const app = buildApp(services);

    const response = await app.request("https://app.test/passkeys/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
      body: JSON.stringify({
        challengeId: "cmd_1",
        challenge: "challenge_value",
        externalCredentialId: "external_credential",
        webauthnResponse: authenticationResponse,
      }),
    });

    expect(response.status).toBe(401);
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("verifies challenge, origin, rpId, signature material, and updates sign counter before passkey sign-in succeeds", async () => {
    const services = createServices();
    const dbQuery = vi.mocked(services.db.query);
    dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            challenge_id: "cmd_1",
            purpose: "passkey-sign-in",
            email: "owner@pokebash.example",
            user_id: "usr_owner",
            challenge_value: "challenge_value",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            credential_id: "crd_1",
            user_id: "usr_owner",
            external_credential_id: "external_credential",
            label: "Passkey",
            public_key: "AQID",
            sign_count: 7,
            credential_device_type: "multiDevice",
            credential_backed_up: true,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const app = buildApp(services);

    const response = await app.request("https://app.test/passkeys/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify({
        challengeId: "cmd_1",
        challenge: "challenge_value",
        externalCredentialId: "external_credential",
        accountId: "acc_new",
        webauthnResponse: authenticationResponse,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "challenge_value",
        expectedOrigin: "https://app.test",
        expectedRPID: "app.test",
        expectedType: "webauthn.get",
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: "required" },
        credential: {
          id: "external_credential",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 7,
        },
      }),
    );
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining("UPDATE identity_passkey_credentials"), [
      "external_credential",
      8,
      "multiDevice",
      true,
    ]);
    expect(services.sessions.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "StartSession",
          userId: "usr_owner",
          accountId: "acc_new",
        }),
      }),
    );
  });

  it("rejects invalid signatures and sign counter regressions reported by WebAuthn verification", async () => {
    mockVerifyAuthenticationResponse.mockRejectedValue(new Error("Response counter value was lower than expected"));
    const services = createServices();
    const dbQuery = vi.mocked(services.db.query);
    dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            challenge_id: "cmd_1",
            purpose: "passkey-sign-in",
            email: "owner@pokebash.example",
            user_id: "usr_owner",
            challenge_value: "challenge_value",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            credential_id: "crd_1",
            user_id: "usr_owner",
            external_credential_id: "external_credential",
            label: "Passkey",
            public_key: "AQID",
            sign_count: 7,
            credential_device_type: "multiDevice",
            credential_backed_up: true,
          },
        ],
      });
    const app = buildApp(services);

    const response = await app.request("https://app.test/passkeys/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify({
        challengeId: "cmd_1",
        challenge: "challenge_value",
        externalCredentialId: "external_credential",
        accountId: "acc_new",
        webauthnResponse: authenticationResponse,
      }),
    });

    expect(response.status).toBe(401);
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
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

let relayPasskeyAttempt = 0;

/** Drive the real passkey first-use relay to Identity's failure. */
async function attemptRelayRegistration(failure: unknown) {
  relayPasskeyAttempt += 1;
  const services = createServices();
  vi.mocked(services.db.query)
    .mockResolvedValueOnce({
      rows: [
        {
          challenge_id: "cmd_1",
          purpose: "passkey-register",
          email: `relay-${relayPasskeyAttempt}@pokebash.example`,
          user_id: null,
          challenge_value: "challenge_value",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          consumed_at: new Date().toISOString(),
        },
      ],
    })
    .mockResolvedValue({ rows: [] });
  mockVerifiedRegistration();
  mockCreatePersonalIdentity.mockImplementation(async () => {
    throw failure;
  });
  mockCreateIdentityAuthRequestClient.mockReturnValue({
    createPersonalIdentity: mockCreatePersonalIdentity,
    registerPasskeyCredential: mockRegisterPasskeyCredential,
  });
  const app = buildApp(services);
  app.onError(errorHandler);

  return app.request("/passkeys/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: "cmd_1",
      challenge: "challenge_value",
      displayName: "PokeBash TCG",
      externalCredentialId: "external_credential",
      label: "Passkey",
      webauthnResponse: registrationResponse,
    }),
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
