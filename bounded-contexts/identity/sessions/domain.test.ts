import { describe, expect, it } from "vitest";
import { decideSession, evolveSession, initialSessionState } from "./domain";

describe("session domain", () => {
  it("switches the active account for a session", () => {
    const started = decideSession(initialSessionState, {
      type: "StartSession",
      sessionId: "ses_test" as never,
      userId: "usr_test" as never,
      accountId: "acc_one" as never,
      availableAccountIds: ["acc_one", "acc_two"],
      authenticationMethod: "password",
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
    const startedState = started.reduce(evolveSession, initialSessionState);
    const switched = decideSession(startedState, {
      type: "SwitchSessionAccount",
      accountId: "acc_two" as never,
    });
    const switchedState = switched.reduce(evolveSession, startedState);

    expect(switchedState.accountId).toBe("acc_two");
  });
});
