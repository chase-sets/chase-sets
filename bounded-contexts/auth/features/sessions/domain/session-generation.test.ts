import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  foldUserSessionAuthority,
  isCurrentSessionGeneration,
  SESSION_GENERATION_ADVANCED_EVENT_TYPE,
  SESSION_GENERATION_CAPABILITY_VERSION,
  SESSION_GENERATION_SCHEMA_MIGRATION_ID,
  sessionGenerationCapabilityReport,
  sessionGenerationOf,
  toUserSessionAuthorityStreamId,
  UserSessionAuthorityUnreadableError,
} from "./session-generation";

/** Synthetic identities only; the `_synthetic_` infix is the marker. */
const USER_ID = "usr_synthetic_authority_fold";
const STREAM_ID = toUserSessionAuthorityStreamId(USER_ID);

function advanced(
  streamVersion: number,
  payload: Record<string, unknown>,
  overrides: Partial<Pick<StoredEvent, "eventType" | "streamId">> = {},
): StoredEvent {
  return {
    eventId: `evt_synthetic_authority_${streamVersion}` as never,
    streamId: overrides.streamId ?? STREAM_ID,
    streamVersion,
    globalPosition: String(streamVersion) as never,
    tenantId: "tnt_synthetic" as never,
    eventType: overrides.eventType ?? SESSION_GENERATION_ADVANCED_EVENT_TYPE,
    payload: payload as never,
    metadata: {} as never,
    occurredAt: "2026-11-02T00:00:00.000Z" as never,
    recordedAt: "2026-11-02T00:00:00.000Z" as never,
    performedByUserId: USER_ID as never,
    forAccountId: "acc_synthetic_authority_fold" as never,
  };
}

describe("User Session Authority fold", () => {
  it("folds a User without an authority stream to generation 0 at version 0", () => {
    expect(foldUserSessionAuthority(USER_ID, [])).toEqual({ userId: USER_ID, sessionGeneration: 0, version: 0 });
  });

  it("folds every monotonic advance and reports the version the start guard must expect", () => {
    const history = [
      advanced(1, { userId: USER_ID, sessionGeneration: 1 }),
      advanced(2, { userId: USER_ID, sessionGeneration: 2, preservedSessionId: "ses_synthetic_extra_field" }),
      advanced(3, { userId: USER_ID, sessionGeneration: 5 }),
    ];

    expect(foldUserSessionAuthority(USER_ID, history)).toEqual({
      userId: USER_ID,
      sessionGeneration: 5,
      version: 3,
    });
  });

  it.each([
    ["foreign-event", [advanced(1, { userId: "usr_synthetic_other", sessionGeneration: 1 })]],
    ["foreign-event", [advanced(1, { userId: USER_ID, sessionGeneration: 1 }, { streamId: "auth.other-stream" })]],
    ["unknown-event", [advanced(1, { userId: USER_ID }, { eventType: "auth.user-session-authority.reset" })]],
    ["malformed-generation", [advanced(1, { userId: USER_ID, sessionGeneration: "1" })]],
    ["malformed-generation", [advanced(1, { userId: USER_ID, sessionGeneration: -1 })]],
    ["malformed-generation", [advanced(1, { userId: USER_ID })]],
    ["non-monotonic-generation", [advanced(1, { userId: USER_ID, sessionGeneration: 0 })]],
    [
      "non-monotonic-generation",
      [advanced(1, { userId: USER_ID, sessionGeneration: 2 }), advanced(2, { userId: USER_ID, sessionGeneration: 2 })],
    ],
  ] as const)("refuses an ambiguous authority (%s)", (reason, history) => {
    let error: unknown;
    try {
      foldUserSessionAuthority(USER_ID, history);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UserSessionAuthorityUnreadableError);
    expect((error as UserSessionAuthorityUnreadableError).reason).toBe(reason);
  });
});

describe("Session Generation of a Session", () => {
  it("reads a pre-floor start as 0 and refuses a malformed value", () => {
    expect(sessionGenerationOf({})).toBe(0);
    expect(sessionGenerationOf({ sessionGeneration: undefined })).toBe(0);
    expect(sessionGenerationOf({ sessionGeneration: 4 })).toBe(4);
    expect(sessionGenerationOf({ sessionGeneration: null })).toBeNull();
    expect(sessionGenerationOf({ sessionGeneration: 1.5 })).toBeNull();
    expect(sessionGenerationOf({ sessionGeneration: "0" })).toBeNull();
  });

  it("is current only in exactly its User's authority generation", () => {
    expect(isCurrentSessionGeneration(0, { sessionGeneration: 0 })).toBe(true);
    expect(isCurrentSessionGeneration(0, { sessionGeneration: 1 })).toBe(false);
    expect(isCurrentSessionGeneration(2, { sessionGeneration: 1 })).toBe(false);
    expect(isCurrentSessionGeneration(null, { sessionGeneration: 0 })).toBe(false);
  });
});

describe("Session Generation capability report", () => {
  it("composes this code's capability and Auth schema ledger with the pod's deployment identity", () => {
    expect(
      sessionGenerationCapabilityReport({
        implementationSha: "a".repeat(40),
        deploymentInstance: '["support-deployment-instance/v1","synthetic","synthetic-release"]',
        schemaMigrationIds: ["20260710_auth_unlogged_projections", SESSION_GENERATION_SCHEMA_MIGRATION_ID],
      }),
    ).toEqual({
      schemaVersion: "auth-session-generation-capability/v1",
      capabilityVersion: SESSION_GENERATION_CAPABILITY_VERSION,
      commit: "a".repeat(40),
      release: '["support-deployment-instance/v1","synthetic","synthetic-release"]',
      schemaLedger: ["20260710_auth_unlogged_projections", SESSION_GENERATION_SCHEMA_MIGRATION_ID],
    });
  });

  it("reports a missing deployment identity as null for the receipt to refuse", () => {
    expect(
      sessionGenerationCapabilityReport({
        implementationSha: "",
        deploymentInstance: undefined,
        schemaMigrationIds: [],
      }),
    ).toMatchObject({ commit: null, release: null, schemaLedger: [] });
  });
});
