import { describe, expect, it } from "vitest";
import {
  decideSession,
  evolveSession,
  initialSessionState,
  type SessionEvent,
  type SessionState,
  type StartSessionCommand,
} from "./domain";
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
      sessionGeneration: 0,
    });
    const switched = decideSession(apply(started), {
      type: "SwitchSessionAccount",
      accountId: "acc_a" as never,
    });

    expect(started[0]).toMatchObject({
      data: {
        availableAccountIds: ["acc_a", "acc_b"],
      },
    });
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
        sessionGeneration: 0,
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

  describe("Session Generation on the Session aggregate", () => {
    const start = {
      type: "StartSession",
      sessionId: "ses_synthetic_generation" as never,
      userId: "usr_synthetic_generation" as never,
      accountId: "acc_synthetic_generation" as never,
      availableAccountIds: ["acc_synthetic_generation"],
      authenticationMethod: "password",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } satisfies Omit<StartSessionCommand, "sessionGeneration">;

    it("records the authority generation on the started event and keeps it across lifecycle changes", () => {
      const started = decideSession(initialSessionState, { ...start, sessionGeneration: 3 });

      expect(started[0]).toMatchObject({ type: "auth.session.started", data: { sessionGeneration: 3 } });
      const revoked = evolveSession(apply(started), { type: "auth.session.revoked", data: {} });
      expect(revoked).toMatchObject({ sessionGeneration: 3, status: "revoked" });
    });

    it("reads a start recorded before the floor as generation 0 and a malformed one as no generation", () => {
      const preFloorData = {
        sessionId: start.sessionId,
        userId: start.userId,
        accountId: start.accountId,
        availableAccountIds: start.availableAccountIds,
        authenticationMethod: start.authenticationMethod,
        expiresAt: start.expiresAt,
      };

      expect(apply([{ type: "auth.session.started", data: preFloorData }]).sessionGeneration).toBe(0);
      expect(
        apply([{ type: "auth.session.started", data: { ...preFloorData, sessionGeneration: -1 } }]).sessionGeneration,
      ).toBeNull();
      expect(
        apply([{ type: "auth.session.started", data: { ...preFloorData, sessionGeneration: "1" as never } }])
          .sessionGeneration,
      ).toBeNull();
    });

    it.each([undefined, -1, 1.5, Number.NaN, "0"])("refuses a start without a valid generation (%s)", (generation) => {
      expect(() =>
        decideSession(initialSessionState, { ...start, sessionGeneration: generation as unknown as number }),
      ).toThrow("Session start requires its authority generation.");
    });

    it.each(["guest:tok_synthetic", "ucp:grant_synthetic"])("refuses to start a Session named %s", (sessionId) => {
      expect(() =>
        decideSession(initialSessionState, { ...start, sessionId: sessionId as never, sessionGeneration: 0 }),
      ).toThrow("A synthetic actor handle cannot start a Session.");
    });
  });

  it("builds stable expiry timestamps and stream ids", () => {
    expect(createExpiryTimestamp(AUTH_SESSION_TTL_MS, Date.UTC(2026, 3, 30))).toBe("2026-05-14T00:00:00.000Z");
    expect(toSessionStreamId("ses_1")).toBe("auth.session-ses_1");
  });
});
