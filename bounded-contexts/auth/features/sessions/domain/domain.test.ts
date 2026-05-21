import { describe, expect, it } from "vitest";
import { decideSession, evolveSession, initialSessionState, type SessionEvent, type SessionState } from "./domain";
import { AUTH_SESSION_TTL_MS, createExpiryTimestamp, toSessionStreamId } from "./auth-flow";

function apply(events: readonly SessionEvent[]): SessionState {
  return events.reduce(evolveSession, initialSessionState);
}

describe("auth session domain", () => {
  it("starts sessions with sorted account choices and switches active account", () => {
    const started = decideSession(initialSessionState, {
      type: "StartSession",
      sessionId: "ses_1" as never,
      userId: "usr_1" as never,
      accountId: "acc_b" as never,
      availableAccountIds: ["acc_b", "acc_a", "acc_b"],
      authenticationMethod: "password",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    const switched = decideSession(apply(started), {
      type: "SwitchSessionAccount",
      accountId: "acc_a" as never,
    });

    expect(started[0]?.data.availableAccountIds).toEqual(["acc_a", "acc_b"]);
    expect(apply([...started, ...switched]).accountId).toBe("acc_a");
  });

  it("rejects inactive or unavailable account changes", () => {
    const state = apply(
      decideSession(initialSessionState, {
        type: "StartSession",
        sessionId: "ses_1" as never,
        userId: "usr_1" as never,
        accountId: "acc_a" as never,
        availableAccountIds: ["acc_a"],
        authenticationMethod: "magic-link",
        expiresAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    expect(() => decideSession(state, { type: "SwitchSessionAccount", accountId: "acc_b" as never })).toThrow(
      "Session cannot switch to an unavailable account.",
    );
    expect(() =>
      decideSession(evolveSession(state, { type: "auth.session.revoked", data: {} }), {
        type: "ExpireSession",
      }),
    ).toThrow("Only active sessions can change.");
  });

  it("builds stable expiry timestamps and stream ids", () => {
    expect(createExpiryTimestamp(AUTH_SESSION_TTL_MS, Date.UTC(2026, 3, 30))).toBe("2026-05-14T00:00:00.000Z");
    expect(toSessionStreamId("ses_1")).toBe("auth.session-ses_1");
  });
});
