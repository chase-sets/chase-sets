import { describe, expect, it } from "vitest";
import { passkeyMatchesChallengeUser } from "./passkey-routes";

describe("passkey route security", () => {
  it("allows discoverable credentials only when they match the challenged user", () => {
    expect(passkeyMatchesChallengeUser(null, "usr_any")).toBe(true);
    expect(passkeyMatchesChallengeUser("usr_owner", "usr_owner")).toBe(true);
    expect(passkeyMatchesChallengeUser("usr_owner", "usr_other")).toBe(false);
  });
});
