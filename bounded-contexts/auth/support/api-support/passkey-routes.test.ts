import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  decodeCommitReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import type { AuthServices } from "../runtime-support/services";
import { passkeyMatchesChallengeUser, registerPasskeyRoutes, resolvePasskeyRegistrationUserId } from "./passkey-routes";
import type { AuthApiEnv } from "./support";

const { mockCreateIdentityAuthRequestClient, mockCreatePersonalIdentity, mockRegisterPasskeyCredential } = vi.hoisted(
  () => ({
    mockCreateIdentityAuthRequestClient: vi.fn(),
    mockCreatePersonalIdentity: vi.fn(),
    mockRegisterPasskeyCredential: vi.fn(),
  }),
);

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

  return {
    db,
    auth: {
      issueChallenge: vi.fn(() => "challenge_value"),
      issueOpaqueToken: vi.fn(() => "session_token"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserByEmail: vi.fn(async () => null),
      listActiveMembershipsForUser: vi.fn(async () => []),
    },
    sessions: {
      commandHandler: vi.fn(async (input) => ({
        version: 1,
        state: {
          id: input.command.sessionId,
          userId: input.command.userId,
          accountId: input.command.accountId,
          availableAccountIds: input.command.availableAccountIds,
          authenticationMethod: input.command.authenticationMethod,
          status: "active",
          expiresAt: input.command.expiresAt,
        },
        storedEvents: [{ recordedAt: new Date().toISOString() }],
      })),
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
    projectors: [],
  } as unknown as AuthServices;
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

useMockReset(mockCreateIdentityAuthRequestClient, mockCreatePersonalIdentity, mockRegisterPasskeyCredential);

describe("passkey route security", () => {
  it("allows discoverable credentials only when they match the challenged user", () => {
    expect(passkeyMatchesChallengeUser(null, "usr_any")).toBe(true);
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
        publicKey: "public_key",
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
    });
    expect(mockRegisterPasskeyCredential).toHaveBeenCalledWith({
      userId: "usr_new",
      credentialId: expect.stringMatching(/^crd_/),
    });
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_passkey_credentials"),
      expect.arrayContaining(["usr_new", "external_credential", "Passkey", "public_key"]),
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
  });
});
