import { describe, expect, it, vi } from "vitest";
import type { ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { createSessionRuntime, resolveSessionAuthenticatedAt } from "./runtime";
import type { SessionEvent, SessionState } from "../domain/domain";

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
