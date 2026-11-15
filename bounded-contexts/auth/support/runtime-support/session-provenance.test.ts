import { describe, expect, it, vi } from "vitest";
import { currentAuthSessionIdOf, type ResolvedActor } from "@chase-sets/auth-context";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, ReadStreamInput } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createSessionRuntime } from "../../features/sessions/api/runtime";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import {
  SESSION_GENERATION_ADVANCED_EVENT_TYPE,
  toUserSessionAuthorityStreamId,
} from "../../features/sessions/domain/session-generation";
import { createGuestCheckoutActor, resolveActorFromRequest, resolveActorFromSessionToken } from "./runtime";
import { resolveActorFromSessionId, type AuthServices } from "./services";

/**
 * Every identity here is SYNTHETIC; the `_synthetic_` infix is the marker.
 * The Session runtime is the real one over an in-memory event store, so the
 * generation guard and provenance run exactly as in production; only Identity
 * (upstream of Auth) and the token table are stood in.
 */
const USER_ID = "usr_synthetic_provenance";
const ACCOUNT_ID = "acc_synthetic_provenance";
const SESSION_ID = "ses_synthetic_provenance";
const CONTEXT: EventStoreContext = {
  tenantId: "tnt_synthetic_provenance" as never,
  audit: { performedByUserId: USER_ID as never, forAccountId: ACCOUNT_ID as never },
};

function provenanceFixture(tokenRows: Readonly<Record<string, Readonly<{ session_id: string }>>> = {}) {
  const store = createInMemoryEventStore();
  const streamReads: string[] = [];
  const recordingEventStore = {
    ...store.eventStore,
    readStream: async (input: ReadStreamInput) => {
      streamReads.push(input.streamId);
      return store.eventStore.readStream(input);
    },
  } satisfies EventStore;
  const sessions = createSessionRuntime({
    eventStore: recordingEventStore,
    checkpointStore: {} as never,
    db: { query: vi.fn(async () => ({ rows: [] })) } as never,
  });
  const readAuthenticatedSession = vi.spyOn(sessions, "readAuthenticatedSession");
  const getActiveMembershipForUserAccount = vi.fn(async (userId: string) =>
    userId === USER_ID
      ? {
          membership_id: "mbr_synthetic_provenance",
          user_id: USER_ID,
          account_id: ACCOUNT_ID,
          role_key: "viewer",
          role_permissions: ["orders.view"],
          status: "active",
        }
      : null,
  );
  const services = {
    db: {
      query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
        const row = tokenRows[String(params?.[0])];
        return { rows: row ? [{ ...row, token_hash: params?.[0], expires_at: "2099-01-01T00:00:00.000Z" }] : [] };
      }),
    },
    auth: { hashSecret: (value: string) => `hash:${value}` },
    sessions,
    identity: {
      bootstrapTenantId: "tnt_synthetic_provenance",
      getActiveMembershipForUserAccount,
      getUser: vi.fn(async () => ({ user_id: USER_ID, primary_email: null, contact_methods: [] })),
    },
  } as unknown as AuthServices;

  async function startSession(sessionId = SESSION_ID, userId = USER_ID) {
    await sessions.commandHandler({
      streamId: toSessionStreamId(sessionId),
      command: {
        type: "StartSession",
        sessionId: sessionId as never,
        userId: userId as never,
        accountId: ACCOUNT_ID as never,
        availableAccountIds: [ACCOUNT_ID],
        authenticationMethod: "password",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      context: CONTEXT,
    });
  }

  return { store, sessions, services, readAuthenticatedSession, startSession, streamReads };
}

describe("auth-actor-session-provenance", () => {
  it("marks a real Auth Session actor as the only kind with a current Session", async () => {
    const { services, startSession, streamReads } = provenanceFixture();
    await startSession();
    streamReads.length = 0;

    const actor = await resolveActorFromSessionId(services, SESSION_ID);

    expect(actor).toMatchObject({ sessionId: SESSION_ID, sessionProvenance: "auth-session" });
    expect(currentAuthSessionIdOf(actor)).toBe(SESSION_ID);
    expect(new Set(streamReads)).toEqual(
      new Set([toSessionStreamId(SESSION_ID), toUserSessionAuthorityStreamId(USER_ID)]),
    );
  });

  it("marks guest-checkout and linked-platform actors as synthetic with no current Session", async () => {
    const { services } = provenanceFixture();
    const guest = createGuestCheckoutActor(services, { token_id: "tok_synthetic", account_id: ACCOUNT_ID });
    const linked = await resolveActorFromRequest(
      services,
      new Request("https://platform.test/ucp/v1/catalog", { headers: { authorization: "Bearer ucp_at_synthetic" } }),
      {
        linkedPlatformAuthorizations: {
          resolveAccessToken: async () => ({
            authorization_id: "lpa_synthetic",
            platform_profile_url: "https://agent.example/.well-known/ucp",
            user_id: USER_ID,
            account_id: ACCOUNT_ID,
            scopes: ["catalog:read"],
          }),
        },
      },
    );

    expect(guest).toMatchObject({ sessionId: "guest:tok_synthetic", sessionProvenance: "guest-checkout" });
    expect(linked).toMatchObject({ sessionId: "ucp:lpa_synthetic", sessionProvenance: "linked-platform" });
    expect(currentAuthSessionIdOf(guest)).toBeNull();
    expect(currentAuthSessionIdOf(linked)).toBeNull();
  });

  it.each([
    ["missing provenance", { sessionId: SESSION_ID }],
    ["unknown provenance", { sessionId: SESSION_ID, sessionProvenance: "auth-session-v2" }],
    ["guest provenance on a real-looking ID", { sessionId: SESSION_ID, sessionProvenance: "guest-checkout" }],
    [
      "real provenance forged onto a guest handle",
      { sessionId: "guest:tok_synthetic", sessionProvenance: "auth-session" },
    ],
    ["real provenance forged onto a UCP handle", { sessionId: "ucp:lpa_synthetic", sessionProvenance: "auth-session" }],
    ["real provenance with an empty ID", { sessionId: "", sessionProvenance: "auth-session" }],
    ["real provenance with a non-string ID", { sessionId: 7, sessionProvenance: "auth-session" }],
  ])("never treats a forged or incomplete actor as current (%s)", (_label, actor) => {
    expect(currentAuthSessionIdOf(actor as unknown as ResolvedActor)).toBeNull();
  });

  it("has no current Session without an actor", () => {
    expect(currentAuthSessionIdOf(null)).toBeNull();
    expect(currentAuthSessionIdOf(undefined)).toBeNull();
  });

  it.each(["guest:tok_synthetic", "ucp:lpa_synthetic"])(
    "never resolves the synthetic handle %s through an Auth Session stream",
    async (sessionId) => {
      const { services, readAuthenticatedSession, streamReads } = provenanceFixture({
        [`hash:session-token-${sessionId}`]: { session_id: sessionId },
      });

      await expect(resolveActorFromSessionId(services, sessionId)).resolves.toBeNull();
      await expect(resolveActorFromSessionToken(services, `session-token-${sessionId}`)).resolves.toBeNull();
      expect(services.db.query).toHaveBeenCalledWith(expect.stringContaining("identity_session_tokens"), [
        `hash:session-token-${sessionId}`,
      ]);
      expect(readAuthenticatedSession).not.toHaveBeenCalled();
      expect(streamReads).toEqual([]);
    },
  );

  it("fails closed for missing, foreign, and superseded real Session backing", async () => {
    const { services, startSession, store } = provenanceFixture();

    await expect(resolveActorFromSessionId(services, "ses_synthetic_never_started")).resolves.toBeNull();

    await startSession("ses_synthetic_foreign", "usr_synthetic_foreign");
    await expect(resolveActorFromSessionId(services, "ses_synthetic_foreign")).resolves.toBeNull();

    await startSession();
    await store.eventStore.appendToStream({
      streamId: toUserSessionAuthorityStreamId(USER_ID),
      expectedVersion: "no_stream",
      context: CONTEXT,
      events: [
        { eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE, payload: { userId: USER_ID, sessionGeneration: 1 } },
      ],
    });
    await expect(resolveActorFromSessionId(services, SESSION_ID)).resolves.toBeNull();
  });
});
