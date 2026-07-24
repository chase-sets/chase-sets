import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
  IdentityApiError: class IdentityApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${status}`);
    }
  },
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
    expect(mockCreatePersonalIdentity).toHaveBeenCalledWith({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      consentAffirmed: false,
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
