import { describe, expect, it } from "vitest";
import {
  passkeyMatchesChallengeUser,
  resolvePasskeyRegistrationUserId,
} from "./passkey-routes";

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
});
