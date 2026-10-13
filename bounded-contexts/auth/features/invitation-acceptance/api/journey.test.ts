import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityAuthMutationClient } from "@chase-sets/identity/server";
import type { AuthServices } from "../../../support/runtime-support/services";
import {
  createInternalSystemTestActor,
  createTestEventStoreContext,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createInMemoryEventStore } from "../../../../identity/tests/in-memory-event-store";
import { ATTEMPT_STAGES } from "../domain/attempt";
import { acceptInvitationAttempt, lookupInvitationAttempt } from "./journey";
import { readAttempt } from "./attempt-store";
import { invitationAttemptRollout } from "./rollout";
import { consumeChallenge } from "../../../support/auth-support/store";
import { verifyPasskeyRegistration } from "../../../support/auth-support/webauthn";

vi.mock("./rollout", () => ({ invitationAttemptRollout: { active: true, requireAttempt: true } }));
vi.mock("../../../support/auth-support/webauthn", () => ({
  verifyPasskeyRegistration: vi.fn(async () => ({
    externalCredentialId: "synthetic-handle",
    publicKey: "synthetic-public-key",
    signCount: 0,
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
  })),
}));
vi.mock("../../../support/auth-support/store", async (original) => ({
  ...(await original<object>()),
  consumeChallenge: vi.fn(async () => ({ email: "recipient@example.com", challenge_value: "synthetic-challenge" })),
}));
const { start } = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../../support/runtime-support/services", async (original) => ({
  ...(await original<object>()),
  startInteractiveAuth: start,
}));

const context = createTestEventStoreContext(createInternalSystemTestActor());
const attemptId = "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea";
const request = new Request("https://marketplace.test/invite/ivt_invited");

function fixture(kind: "password" | "passkey", existing: boolean) {
  const store = createInMemoryEventStore();
  const counts = { registration: 0, acceptance: 0, email: 0, credential: 0, session: 0, token: 0, store: 0 };
  let userId: string | null = existing ? "usr_existing" : null;
  let accepted = false;
  let emailVerified = false;
  let credentialId: string | null = null;
  const credentials = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, object>();
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.startsWith("INSERT INTO identity_password_credentials")) {
      credentials.set(String(values[1]), { credential_id: values[0], user_id: values[1], secret_hash: values[2] });
      counts.store++;
    }
    if (sql.startsWith("INSERT INTO identity_passkey_credentials")) {
      credentials.set(String(values[0]), { credential_id: values[0], user_id: values[1] });
      counts.store++;
    }
    if (sql.includes("FROM identity_password_credentials"))
      return { rows: credentials.has(String(values[0])) ? [credentials.get(String(values[0]))!] : [] };
    if (sql.includes("FROM identity_passkey_credentials"))
      return { rows: credentials.has(String(values[0])) ? [credentials.get(String(values[0]))!] : [] };
    return { rows: [] };
  });
  const services = {
    eventStore: store,
    db: { query },
    pool: { query, connect: async () => ({ query, release: vi.fn() }) },
    identity: {
      getUserByEmail: async () => (existing ? { user_id: userId } : null),
      normalizeEmail: (email: string) => email.trim().toLowerCase(),
    },
    auth: {
      hashSecret: (value: string) => `synthetic-hash:${value}`,
      hashPassword: async (value: string) => `synthetic-password:${value}`,
      verifyPassword: async (value: string, hash: string) => ({ valid: hash === `synthetic-password:${value}` }),
    },
    sessions: { getSessionState: async (id: string) => sessions.get(id) ?? null },
  } as unknown as AuthServices;
  const identity = {
    readInvitationAcceptanceAuthority: vi.fn(
      async (params: Parameters<IdentityAuthMutationClient["readInvitationAcceptanceAuthority"]>[0]) => {
        if (
          params.acceptanceTokenHash !== "synthetic-hash:synthetic-token" ||
          (params.operation &&
            ((params.operation.userId !== userId && userId !== null) ||
              params.operation.invitationId !== "ivt_invited"))
        )
          throw new Error("synthetic authority refused");
        return {
          invitationId: "ivt_invited",
          accountId: "acc_invited",
          roleKey: "viewer",
          email: "recipient@example.com",
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          accepted,
          user: userId
            ? {
                userId,
                passwordCredentialId: kind === "password" ? credentialId : null,
                passkeyCredentialIds: kind === "passkey" && credentialId ? [credentialId] : [],
                authMethods: credentialId ? [kind] : [],
                emailVerified,
              }
            : null,
        };
      },
    ),
    resolveRegistrationConsent: vi.fn(async () => ({ requirements: [] })),
    createPersonalIdentity: vi.fn(
      async (params: Parameters<IdentityAuthMutationClient["createPersonalIdentity"]>[0]) => {
        counts.registration++;
        userId = params.reservedUserId!;
        return { userId, accountId: "acc_personal", membershipId: "mbr_personal", snapshots: [] };
      },
    ),
    acceptInvitationForUser: vi.fn(
      async (params: Parameters<IdentityAuthMutationClient["acceptInvitationForUser"]>[0]) => {
        counts.acceptance++;
        accepted = true;
        return { membershipId: params.operation!.membershipId, snapshots: [] };
      },
    ),
    verifyEmailContactMethod: vi.fn(async () => {
      counts.email++;
      emailVerified = true;
      return { userId: userId!, snapshots: [] };
    }),
    enablePasswordCredential: vi.fn(
      async (params: Parameters<IdentityAuthMutationClient["enablePasswordCredential"]>[0]) => {
        counts.credential++;
        credentialId = params.credentialId;
        return { ok: true, userId, snapshots: [] };
      },
    ),
    registerPasskeyCredential: vi.fn(
      async (params: Parameters<IdentityAuthMutationClient["registerPasskeyCredential"]>[0]) => {
        counts.credential++;
        credentialId = params.credentialId;
        return { ok: true, userId, snapshots: [] };
      },
    ),
  } as unknown as IdentityAuthMutationClient;
  start.mockImplementation(async (_services, params) => {
    counts.session++;
    counts.token++;
    sessions.set(params.sessionId, { id: params.sessionId, status: "active" });
    return { type: "session-started", sessionId: params.sessionId, sessionToken: "synthetic-first-response-secret" };
  });
  const input = {
    attemptId,
    invitationId: "ivt_invited",
    token: "synthetic-token",
    ...(kind === "password"
      ? { password: "synthetic-password" }
      : { challengeId: "cmd_ceremony", challenge: "synthetic-challenge", webauthnResponse: "{}" }),
  };
  return { services, identity, input, counts, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(invitationAttemptRollout, { active: true });
  start.mockReset();
});
describe("invitation-acceptance-stage-recovery", () => {
  it("reads stored passkey ceremony material after a pre-checkpoint fault without consuming or verifying again", async () => {
    const f = fixture("passkey", true);
    const append = f.store.appendToStream;
    let faulted = false;
    const services = {
      ...f.services,
      eventStore: {
        ...f.store,
        appendToStream: async (input: Parameters<typeof append>[0]) => {
          if (!faulted && input.events[0]?.payload.stage === "ceremony-stored") {
            faulted = true;
            throw new Error("synthetic pre-checkpoint fault");
          }
          return append(input);
        },
      },
    };
    await expect(acceptInvitationAttempt(services, f.identity, f.input, request, context)).rejects.toThrow();
    expect((await acceptInvitationAttempt(f.services, f.identity, f.input, request, context)).type).toBe(
      "session-started",
    );
    expect(consumeChallenge).toHaveBeenCalledOnce();
    expect(verifyPasskeyRegistration).toHaveBeenCalledOnce();
    expect(f.counts.store).toBe(1);
  });
  it("a Session committed before its completed checkpoint is recovered without a second Session or token", async () => {
    const f = fixture("password", true);
    const append = f.store.appendToStream;
    let faulted = false;
    const services = {
      ...f.services,
      eventStore: {
        ...f.store,
        appendToStream: async (input: Parameters<typeof append>[0]) => {
          if (!faulted && input.events[0]?.payload.stage === "completed") {
            faulted = true;
            throw new Error("synthetic pre-checkpoint fault");
          }
          return append(input);
        },
      },
    };
    await expect(acceptInvitationAttempt(services, f.identity, f.input, request, context)).rejects.toThrow();
    expect((await acceptInvitationAttempt(f.services, f.identity, f.input, request, context)).type).toBe(
      "accepted-reauth-required",
    );
    expect(f.counts.session).toBe(1);
    expect(f.counts.token).toBe(1);
    expect((await readAttempt(f.store, attemptId, context))?.stage).toBe("completed");
  });
  it("refuses unaffirmed nonempty Consent before attempt, credential or Session writes", async () => {
    const f = fixture("password", false);
    vi.mocked(f.identity.resolveRegistrationConsent).mockResolvedValue({
      bundleKey: "registration",
      resolvedAt: new Date().toISOString(),
      signature: "synthetic-not-a-server-proof",
      requirements: [{ policyKey: "terms-of-service", version: "synthetic-v1", href: "/terms" }],
    });
    vi.mocked(f.identity.createPersonalIdentity).mockRejectedValue(new Error("synthetic owner Consent refusal"));
    await expect(acceptInvitationAttempt(f.services, f.identity, f.input, request, context)).rejects.toThrow();
    expect(f.store.streams.size).toBe(0);
    expect(f.identity.createPersonalIdentity).not.toHaveBeenCalled();
    expect(f.counts).toEqual({
      registration: 0,
      acceptance: 0,
      email: 0,
      credential: 0,
      session: 0,
      token: 0,
      store: 0,
    });
  });
  for (const kind of ["password", "passkey"] as const)
    for (const existing of [false, true]) {
      it.each(ATTEMPT_STAGES)(
        `${kind} ${existing ? "existing" : "new"} User resumes after a lost %s checkpoint without repeat effects`,
        async (stage) => {
          const f = fixture(kind, existing);
          const append = f.store.appendToStream;
          let injected = false;
          f.services = {
            ...f.services,
            eventStore: {
              ...f.store,
              appendToStream: async (input) => {
                const result = await append(input);
                if (!injected && input.events[0]?.payload.stage === stage) {
                  injected = true;
                  throw new Error("synthetic lost checkpoint response");
                }
                return result;
              },
            },
          };
          await expect(acceptInvitationAttempt(f.services, f.identity, f.input, request, context)).rejects.toThrow();
          const resumed = await acceptInvitationAttempt(f.services, f.identity, f.input, request, context);
          expect(resumed.type).toBe(stage === "completed" ? "accepted-reauth-required" : "session-started");
          expect(f.counts).toEqual({
            registration: existing ? 0 : 1,
            acceptance: 1,
            email: 1,
            credential: 1,
            session: 1,
            token: 1,
            store: 1,
          });
          expect((await readAttempt(f.store, attemptId, context))?.stage).toBe("completed");
          expect(JSON.stringify([...f.store.streams.values()])).not.toMatch(
            /synthetic-token|synthetic-password|synthetic-challenge|synthetic-public-key|synthetic-first-response-secret/,
          );
        },
      );
    }
});

describe("invitation-acceptance-response-loss", () => {
  it("does not treat revoked credential authority as a completed checkpoint", async () => {
    const f = fixture("password", true);
    await acceptInvitationAttempt(f.services, f.identity, f.input, request, context);
    const state = await readAttempt(f.store, attemptId, context);
    vi.mocked(f.identity.readInvitationAcceptanceAuthority).mockResolvedValue({
      invitationId: f.input.invitationId,
      accountId: "acc_invited",
      roleKey: "viewer",
      email: "recipient@example.com",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      accepted: true,
      user: {
        userId: state!.binding.userId,
        passwordCredentialId: state!.binding.credentialId,
        passkeyCredentialIds: [],
        authMethods: [],
        emailVerified: true,
      },
    });
    await expect(lookupInvitationAttempt(f.services, f.identity, f.input, context)).rejects.toThrow();
    expect(f.counts.session).toBe(1);
    expect(f.counts.token).toBe(1);
  });
  it("invitation-acceptance-compatibility-floor retains completed attempts after deactivation and refuses new ones", async () => {
    const f = fixture("password", true);
    await acceptInvitationAttempt(f.services, f.identity, f.input, request, context);
    const counts = { ...f.counts };
    Object.assign(invitationAttemptRollout, { active: false });
    expect((await acceptInvitationAttempt(f.services, f.identity, f.input, request, context)).type).toBe(
      "accepted-reauth-required",
    );
    expect(
      await acceptInvitationAttempt(
        f.services,
        f.identity,
        { ...f.input, attemptId: "fe477381-15cc-4ca8-9a40-a004a01ee107" },
        request,
        context,
      ),
    ).toEqual({ type: "attempts-not-active" });
    expect(f.counts).toEqual(counts);
  });
  it("a lost Session response and repeated lookup never create another Session or token", async () => {
    const f = fixture("password", true);
    await acceptInvitationAttempt(f.services, f.identity, f.input, request, context);
    const before = { ...f.counts };
    expect(await lookupInvitationAttempt(f.services, f.identity, f.input, context)).toEqual({
      type: "accepted-reauth-required",
      attemptId,
    });
    expect((await acceptInvitationAttempt(f.services, f.identity, f.input, request, context)).type).toBe(
      "accepted-reauth-required",
    );
    expect(f.counts).toEqual(before);
    expect(f.identity.readInvitationAcceptanceAuthority).toHaveBeenCalled();
  });
  it("verifier-only lookup is inert and a different ceremony or Invitation conflicts", async () => {
    const f = fixture("password", true);
    expect(await lookupInvitationAttempt(f.services, f.identity, f.input, context)).toEqual({
      type: "ambiguous",
      attemptId,
    });
    expect(f.counts.session).toBe(0);
    await acceptInvitationAttempt(f.services, f.identity, f.input, request, context);
    await expect(
      acceptInvitationAttempt(f.services, f.identity, { ...f.input, challengeId: "cmd_other" }, request, context),
    ).rejects.toThrow();
    await expect(
      acceptInvitationAttempt(f.services, f.identity, { ...f.input, invitationId: "ivt_other" }, request, context),
    ).rejects.toThrow();
  });
});
