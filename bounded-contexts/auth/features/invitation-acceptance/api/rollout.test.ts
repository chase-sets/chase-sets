import { describe, expect, it } from "vitest";
import { invitationAttemptRollout } from "./rollout";

describe("invitation-acceptance-compatibility-floor", () => {
  it("activates attempts in the shared image without refusing legacy clients", () => {
    expect(invitationAttemptRollout).toEqual({ active: true, requireAttempt: false });
  });
});
