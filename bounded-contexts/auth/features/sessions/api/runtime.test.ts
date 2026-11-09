import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { EventStreamTooLongError } from "@chase-sets/event-core/complete-stream";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createSessionRuntime, resolveSessionAuthenticatedAt } from "./runtime";
import type { SessionEvent, SessionState, StartSessionRequest } from "../domain/domain";
import { toSessionStreamId } from "../domain/auth-flow";
import {
  SESSION_GENERATION_ADVANCED_EVENT_TYPE,
  toUserSessionAuthorityStreamId,
  USER_SESSION_AUTHORITY_MAX_EVENTS,
  UserSessionAuthorityUnreadableError,
} from "../domain/session-generation";

/**
 * Every identity below is SYNTHETIC and exists only inside this file. None of
 * them corresponds to a seeded, staging, or production session, user, or
 * account -- the `_synthetic_` infix is the marker.
 */
const SYNTHETIC_SESSION_ID = "ses_synthetic_authority_control";
const SYNTHETIC_STREAM_ID = `auth.session-${SYNTHETIC_SESSION_ID}`;
const SYNTHETIC_USER_ID = "usr_synthetic_authority_control";
const SYNTHETIC_ACCOUNT_ID = "acc_synthetic_authority_control";

/** Frozen, non-governing. Only the authority source varies between cases. */
const SYNTHETIC_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const SYNTHETIC_OLD_RECORDED_AT = "2026-01-02T03:04:05.678Z";
const SYNTHETIC_FRESH_RECORDED_AT = "2026-08-10T11:22:33.444Z";
/** Deliberately different from `recordedAt`: `occurredAt` is caller-supplied and is never the authority. */
const SYNTHETIC_OCCURRED_AT = "2020-06-06T06:06:06.000Z";

const SESSION_STARTED = "auth.session.started";
const SESSION_ACCOUNT_SWITCHED = "auth.session.account-switched";

function syntheticStartPayload() {
  return {
    sessionId: SYNTHETIC_SESSION_ID,
    userId: SYNTHETIC_USER_ID,
    accountId: SYNTHETIC_ACCOUNT_ID,
    availableAccountIds: [SYNTHETIC_ACCOUNT_ID],
    authenticationMethod: "password",
    expiresAt: SYNTHETIC_EXPIRES_AT,
  };
}

function syntheticStoredEvent(
  input: Readonly<{
    streamVersion: number;
    eventType: string;
    payload?: Record<string, unknown>;
    recordedAt: string;
    occurredAt?: string;
  }>,
): StoredEvent {
  return {
    eventId: `evt_synthetic_${input.streamVersion}` as never,
    streamId: SYNTHETIC_STREAM_ID,
    streamVersion: input.streamVersion,
    globalPosition: String(input.streamVersion) as never,
    tenantId: "tnt_synthetic" as never,
    eventType: input.eventType,
    payload: (input.payload ?? {}) as never,
    metadata: {} as never,
    occurredAt: (input.occurredAt ?? input.recordedAt) as never,
    recordedAt: input.recordedAt as never,
    performedByUserId: SYNTHETIC_USER_ID as never,
    forAccountId: SYNTHETIC_ACCOUNT_ID as never,
  };
}

/** Decoded view of a stored event, exactly as the passthrough codec produces it. */
function decodedFrom(storedEvents: readonly StoredEvent[]): readonly SessionEvent[] {
  return storedEvents.map(
    (storedEvent) => ({ type: storedEvent.eventType, data: storedEvent.payload }) as SessionEvent,
  );
}

function loadedFrom(storedEvents: readonly StoredEvent[]) {
  return { events: decodedFrom(storedEvents), storedEvents };
}

/**
 * Minimal read-only event store whose stream contents this suite controls
 * exactly, so `recordedAt` is an input rather than a wall-clock side effect.
 */
function createSyntheticStreamStore(storedEvents: readonly StoredEvent[]) {
  const readStream = vi.fn(async (input: ReadStreamInput) => {
    if (input.streamId !== SYNTHETIC_STREAM_ID) {
      return [];
    }
    const fromVersion = input.fromVersion ?? 1;
    return storedEvents.filter((storedEvent) => storedEvent.streamVersion >= fromVersion);
  });

  return {
    readStream,
    eventStore: {
      appendToStream: vi.fn(async () => []),
      readStream,
      readAll: vi.fn(async () => []),
    },
  };
}

function createRuntime(storedEvents: readonly StoredEvent[]) {
  const store = createSyntheticStreamStore(storedEvents);
  const sessions = createSessionRuntime({
    eventStore: store.eventStore,
    checkpointStore: {} as never,
    db: { query: vi.fn(async () => ({ rows: [] })) } as never,
  });

  return { sessions, ...store };
}

describe("resolveSessionAuthenticatedAt", () => {
  it("returns the exact stored recordedAt of the single start event, not occurredAt", () => {
    const storedEvents = [
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: SYNTHETIC_OLD_RECORDED_AT,
        occurredAt: SYNTHETIC_OCCURRED_AT,
      }),
    ];

    expect(resolveSessionAuthenticatedAt(loadedFrom(storedEvents))).toBe(SYNTHETIC_OLD_RECORDED_AT);
  });

  it("preserves the start event's recordedAt even when later events were recorded much later", () => {
    const storedEvents = [
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: SYNTHETIC_OLD_RECORDED_AT,
      }),
      syntheticStoredEvent({
        streamVersion: 2,
        eventType: SESSION_ACCOUNT_SWITCHED,
        payload: { accountId: SYNTHETIC_ACCOUNT_ID },
        recordedAt: SYNTHETIC_FRESH_RECORDED_AT,
      }),
    ];

    expect(resolveSessionAuthenticatedAt(loadedFrom(storedEvents))).toBe(SYNTHETIC_OLD_RECORDED_AT);
  });

  it("returns null when the loaded events are a suffix that omits the start event", () => {
    // The shape a snapshot base produces: aggregate state exists, but the
    // loaded slice begins after the start event was folded away.
    const storedEvents = [
      syntheticStoredEvent({
        streamVersion: 7,
        eventType: SESSION_ACCOUNT_SWITCHED,
        payload: { accountId: SYNTHETIC_ACCOUNT_ID },
        recordedAt: SYNTHETIC_FRESH_RECORDED_AT,
      }),
    ];

    expect(resolveSessionAuthenticatedAt(loadedFrom(storedEvents))).toBeNull();
  });

  it("returns null for an empty load", () => {
    expect(resolveSessionAuthenticatedAt(loadedFrom([]))).toBeNull();
  });

  it("returns null when the stream carries more than one start event", () => {
    const storedEvents = [
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: SYNTHETIC_OLD_RECORDED_AT,
      }),
      syntheticStoredEvent({
        streamVersion: 2,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: SYNTHETIC_FRESH_RECORDED_AT,
      }),
    ];

    expect(resolveSessionAuthenticatedAt(loadedFrom(storedEvents))).toBeNull();
  });

  it("returns null when the decoded and stored views disagree on which position is the start event", () => {
    const storedEvents = [
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_ACCOUNT_SWITCHED,
        payload: { accountId: SYNTHETIC_ACCOUNT_ID },
        recordedAt: SYNTHETIC_FRESH_RECORDED_AT,
      }),
    ];
    const misalignedDecoded = [{ type: SESSION_STARTED, data: syntheticStartPayload() } as never];

    expect(resolveSessionAuthenticatedAt({ events: misalignedDecoded, storedEvents })).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["unparsable", "not-a-timestamp"],
  ])("returns null when the start event's recordedAt is %s", (_label, recordedAt) => {
    const storedEvents = [
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt,
      }),
    ];

    expect(resolveSessionAuthenticatedAt(loadedFrom(storedEvents))).toBeNull();
  });
});

describe("SessionServices.readAuthenticatedSession", () => {
  it("carries the exact old recordedAt for a session started long ago", async () => {
    const { sessions } = createRuntime([
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: SYNTHETIC_OLD_RECORDED_AT,
        occurredAt: SYNTHETIC_OCCURRED_AT,
      }),
    ]);

    const read = await sessions.readAuthenticatedSession(SYNTHETIC_SESSION_ID);

    expect(read?.authenticatedAt).toBe(SYNTHETIC_OLD_RECORDED_AT);
    expect(read?.state).toMatchObject<Partial<SessionState>>({
      id: SYNTHETIC_SESSION_ID as never,
      userId: SYNTHETIC_USER_ID as never,
      accountId: SYNTHETIC_ACCOUNT_ID as never,
      status: "active",
      expiresAt: SYNTHETIC_EXPIRES_AT,
    });
  });

  it("carries the exact fresh recordedAt for a session started moments ago", async () => {
    const { sessions } = createRuntime([
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: SYNTHETIC_FRESH_RECORDED_AT,
      }),
    ]);

    const read = await sessions.readAuthenticatedSession(SYNTHETIC_SESSION_ID);

    expect(read?.authenticatedAt).toBe(SYNTHETIC_FRESH_RECORDED_AT);
  });

  it("reports a null authentication moment when the start event's recordedAt is unusable", async () => {
    const { sessions } = createRuntime([
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: "not-a-timestamp",
      }),
    ]);

    const read = await sessions.readAuthenticatedSession(SYNTHETIC_SESSION_ID);

    expect(read?.state.id).toBe(SYNTHETIC_SESSION_ID);
    expect(read?.authenticatedAt).toBeNull();
  });

  it("returns null for a stream that never started a session", async () => {
    const { sessions } = createRuntime([]);

    await expect(sessions.readAuthenticatedSession(SYNTHETIC_SESSION_ID)).resolves.toBeNull();
  });

  it("leaves getSessionState -- the read Auth seed reconciliation depends on -- unchanged", async () => {
    const { sessions } = createRuntime([
      syntheticStoredEvent({
        streamVersion: 1,
        eventType: SESSION_STARTED,
        payload: syntheticStartPayload(),
        recordedAt: SYNTHETIC_OLD_RECORDED_AT,
      }),
    ]);

    const state = await sessions.getSessionState(SYNTHETIC_SESSION_ID);
    const read = await sessions.readAuthenticatedSession(SYNTHETIC_SESSION_ID);

    expect(state).toEqual(read?.state);
    // No timestamp leaked into domain state -- the moment of authentication is
    // a storage fact carried alongside it, never folded into the aggregate.
    expect(state).not.toHaveProperty("authenticatedAt");
    expect(state).not.toHaveProperty("startedAt");
    await expect(sessions.getSessionState("ses_synthetic_never_started")).resolves.toBeNull();
  });
});

const GUARD_USER_ID = "usr_synthetic_generation_guard";
const GUARD_SESSION_ID = "ses_synthetic_generation_guard";
const GUARD_AUTHORITY_STREAM_ID = toUserSessionAuthorityStreamId(GUARD_USER_ID);
const GUARD_CONTEXT: EventStoreContext = {
  tenantId: "tnt_synthetic_generation_guard" as never,
  audit: { performedByUserId: GUARD_USER_ID as never, forAccountId: "acc_synthetic_generation_guard" as never },
};

function guardStartRequest(sessionId = GUARD_SESSION_ID): StartSessionRequest {
  return {
    type: "StartSession",
    sessionId: sessionId as never,
    userId: GUARD_USER_ID as never,
    accountId: "acc_synthetic_generation_guard" as never,
    availableAccountIds: ["acc_synthetic_generation_guard"],
    authenticationMethod: "password",
    expiresAt: SYNTHETIC_EXPIRES_AT,
  };
}

/** Stands in for the later bulk command: the only writer of authority history, and only in tests. */
async function advanceAuthority(eventStore: EventStore, sessionGeneration: number) {
  const history = await eventStore.readStream({ streamId: GUARD_AUTHORITY_STREAM_ID });
  await eventStore.appendToStream({
    streamId: GUARD_AUTHORITY_STREAM_ID,
    expectedVersion: history.length === 0 ? "no_stream" : history.length,
    context: GUARD_CONTEXT,
    events: [
      { eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE, payload: { userId: GUARD_USER_ID, sessionGeneration } },
    ],
  });
}

/**
 * Runs `onAuthorityRead` after the start guard has read authority and before
 * it appends -- the commit-order window the atomic version guard closes.
 */
function withAuthorityReadBarrier(eventStore: EventStore, onAuthorityRead: (read: number) => Promise<void>) {
  let reads = 0;
  return {
    ...eventStore,
    readStream: async (input: ReadStreamInput) => {
      const page = await eventStore.readStream(input);
      if (input.streamId === GUARD_AUTHORITY_STREAM_ID) {
        reads += 1;
        await onAuthorityRead(reads);
      }
      return page;
    },
  } satisfies EventStore;
}

function guardRuntime(eventStore: EventStore) {
  return createSessionRuntime({
    eventStore,
    checkpointStore: {} as never,
    db: { query: vi.fn(async () => ({ rows: [] })) } as never,
  });
}

async function startGuarded(sessions: ReturnType<typeof guardRuntime>, request = guardStartRequest()) {
  return sessions.commandHandler({
    streamId: toSessionStreamId(request.sessionId),
    command: request,
    context: GUARD_CONTEXT,
  });
}

describe("session-start-generation-zero-guard (in-memory event store)", () => {
  it("starts a User without authority in generation 0 and adds no authority history", async () => {
    const store = createInMemoryEventStore();
    const sessions = guardRuntime(store.eventStore);

    const result = await startGuarded(sessions);

    expect(result.state).toMatchObject({ id: GUARD_SESSION_ID, status: "active", sessionGeneration: 0 });
    expect(result.storedEvents.map((event) => event.payload.sessionGeneration)).toEqual([0]);
    expect(store.streams.get(GUARD_AUTHORITY_STREAM_ID) ?? []).toEqual([]);
    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.toMatchObject({
      state: { sessionGeneration: 0 },
      authenticatedAt: result.storedEvents[0]?.recordedAt,
    });
  });

  it("starts in the authority's current generation and ignores a caller-chosen one", async () => {
    const store = createInMemoryEventStore();
    await advanceAuthority(store.eventStore, 1);
    await advanceAuthority(store.eventStore, 2);
    const sessions = guardRuntime(store.eventStore);

    const result = await startGuarded(sessions, {
      ...guardStartRequest(),
      sessionGeneration: 7,
    } as StartSessionRequest);

    expect(result.storedEvents.map((event) => event.payload.sessionGeneration)).toEqual([2]);
    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.not.toBeNull();
  });

  it("conflicts on an authority advanced between its read and append, writes nothing, and retries in the new generation", async () => {
    const store = createInMemoryEventStore();
    const barrier = withAuthorityReadBarrier(store.eventStore, async (read) => {
      if (read === 1) {
        await advanceAuthority(store.eventStore, 1);
      }
    });
    const sessions = guardRuntime(barrier);

    const result = await startGuarded(sessions);

    const sessionHistory = store.streams.get(toSessionStreamId(GUARD_SESSION_ID)) ?? [];
    expect(sessionHistory.map((event) => [event.eventType, event.payload.sessionGeneration])).toEqual([
      ["auth.session.started", 1],
    ]);
    expect(result.state.sessionGeneration).toBe(1);
    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.not.toBeNull();
  });

  it("refuses the start and leaves no Session when every guarded attempt is stale", async () => {
    const store = createInMemoryEventStore();
    let generation = 0;
    const barrier = withAuthorityReadBarrier(store.eventStore, async () => {
      generation += 1;
      await advanceAuthority(store.eventStore, generation);
    });
    const sessions = guardRuntime(barrier);

    await expect(startGuarded(sessions)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(store.streams.get(toSessionStreamId(GUARD_SESSION_ID)) ?? []).toEqual([]);
    expect(generation).toBe(3);
  });

  it("refuses the start when the event store cannot guard it atomically", async () => {
    const store = createInMemoryEventStore();
    const { appendToStreams: _unused, ...withoutAtomicAppend } = store.eventStore;
    const sessions = guardRuntime(withoutAtomicAppend);

    await expect(startGuarded(sessions)).rejects.toThrow("atomic multi-stream append");
    expect(store.streams.get(toSessionStreamId(GUARD_SESSION_ID)) ?? []).toEqual([]);
  });

  it("refuses the start when authority is unreadable or its read fails", async () => {
    const unreadable = createInMemoryEventStore();
    await unreadable.eventStore.appendToStream({
      streamId: GUARD_AUTHORITY_STREAM_ID,
      expectedVersion: "no_stream",
      context: GUARD_CONTEXT,
      events: [{ eventType: "auth.user-session-authority.unknown", payload: { userId: GUARD_USER_ID } }],
    });
    await expect(startGuarded(guardRuntime(unreadable.eventStore))).rejects.toBeInstanceOf(
      UserSessionAuthorityUnreadableError,
    );
    expect(unreadable.streams.get(toSessionStreamId(GUARD_SESSION_ID)) ?? []).toEqual([]);

    const failing = createInMemoryEventStore();
    const readFailure = withAuthorityReadBarrier(failing.eventStore, async () => {
      throw new Error("synthetic authority read failure");
    });
    await expect(startGuarded(guardRuntime(readFailure))).rejects.toThrow("synthetic authority read failure");
    expect(failing.streams.get(toSessionStreamId(GUARD_SESSION_ID)) ?? []).toEqual([]);
  });

  it("keeps lifecycle commands on the ordinary Session handler", async () => {
    const store = createInMemoryEventStore();
    const sessions = guardRuntime(store.eventStore);
    await startGuarded(sessions);
    await advanceAuthority(store.eventStore, 1);

    const revoked = await sessions.commandHandler({
      streamId: toSessionStreamId(GUARD_SESSION_ID),
      command: { type: "RevokeSession" },
      context: GUARD_CONTEXT,
    });

    expect(revoked.state).toMatchObject({ status: "revoked", sessionGeneration: 0 });
  });
});

describe("session-generation-actor-resolution (in-memory event store)", () => {
  it("rejects a Session once its User's authority moves past its generation", async () => {
    const store = createInMemoryEventStore();
    const sessions = guardRuntime(store.eventStore);
    await startGuarded(sessions);
    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.not.toBeNull();

    await advanceAuthority(store.eventStore, 1);

    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.toBeNull();
    // Lifecycle state still reads; only actor authority is withdrawn.
    await expect(sessions.getSessionState(GUARD_SESSION_ID)).resolves.toMatchObject({ status: "active" });
  });

  it("accepts a pre-floor start without a generation while authority is 0", async () => {
    const store = createInMemoryEventStore();
    const { type: _type, ...preFloorPayload } = guardStartRequest();
    await store.eventStore.appendToStream({
      streamId: toSessionStreamId(GUARD_SESSION_ID),
      expectedVersion: "no_stream",
      context: GUARD_CONTEXT,
      events: [{ eventType: "auth.session.started", payload: preFloorPayload }],
    });
    const sessions = guardRuntime(store.eventStore);

    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.toMatchObject({
      state: { sessionGeneration: 0, status: "active" },
    });
    await advanceAuthority(store.eventStore, 1);
    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.toBeNull();
  });

  it("reads the complete authority history past one 500-event page", async () => {
    const store = createInMemoryEventStore();
    const sessions = guardRuntime(store.eventStore);
    await store.eventStore.appendToStream({
      streamId: GUARD_AUTHORITY_STREAM_ID,
      expectedVersion: "no_stream",
      context: GUARD_CONTEXT,
      events: Array.from({ length: 500 }, (_, index) => ({
        eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE,
        payload: { userId: GUARD_USER_ID, sessionGeneration: index + 1 },
      })),
    });
    await startGuarded(sessions);
    await expect(sessions.readUserSessionAuthority(GUARD_USER_ID)).resolves.toMatchObject({
      sessionGeneration: 500,
      version: 500,
    });
    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.not.toBeNull();

    await advanceAuthority(store.eventStore, 501);

    await expect(sessions.readUserSessionAuthority(GUARD_USER_ID)).resolves.toMatchObject({
      sessionGeneration: 501,
      version: 501,
    });
    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).resolves.toBeNull();
  });

  it("refuses a capped authority history instead of folding a prefix", async () => {
    const store = createInMemoryEventStore();
    const sessions = guardRuntime(store.eventStore);
    await startGuarded(sessions);
    await store.eventStore.appendToStream({
      streamId: GUARD_AUTHORITY_STREAM_ID,
      expectedVersion: "no_stream",
      context: GUARD_CONTEXT,
      events: Array.from({ length: USER_SESSION_AUTHORITY_MAX_EVENTS + 1 }, (_, index) => ({
        eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE,
        payload: { userId: GUARD_USER_ID, sessionGeneration: index + 1 },
      })),
    });

    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).rejects.toBeInstanceOf(EventStreamTooLongError);
    await expect(
      startGuarded(sessions, guardStartRequest("ses_synthetic_generation_guard_capped")),
    ).rejects.toBeInstanceOf(EventStreamTooLongError);
    expect(store.streams.get(toSessionStreamId("ses_synthetic_generation_guard_capped")) ?? []).toEqual([]);
  });

  it("never reads a Session stream for a synthetic actor handle", async () => {
    const store = createInMemoryEventStore();
    const readStream = vi.spyOn(store.eventStore, "readStream");
    const sessions = guardRuntime(store.eventStore);

    await expect(sessions.readAuthenticatedSession("guest:tok_synthetic")).resolves.toBeNull();
    await expect(sessions.readAuthenticatedSession("ucp:grant_synthetic")).resolves.toBeNull();
    expect(readStream).not.toHaveBeenCalled();
  });

  it("fails closed when the User's authority cannot be read", async () => {
    const store = createInMemoryEventStore();
    const sessions = guardRuntime(store.eventStore);
    await startGuarded(sessions);
    await store.eventStore.appendToStream({
      streamId: GUARD_AUTHORITY_STREAM_ID,
      expectedVersion: "no_stream",
      context: GUARD_CONTEXT,
      events: [
        {
          eventType: SESSION_GENERATION_ADVANCED_EVENT_TYPE,
          payload: { userId: "usr_synthetic_foreign", sessionGeneration: 1 },
        },
      ],
    });

    await expect(sessions.readAuthenticatedSession(GUARD_SESSION_ID)).rejects.toBeInstanceOf(
      UserSessionAuthorityUnreadableError,
    );
  });
});
