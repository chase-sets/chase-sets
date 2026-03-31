import { describe, expect, it } from "vitest";
import { decideInvitation, evolveInvitation, initialInvitationState } from "./domain";

describe("invitation domain", () => {
  it("accepts an invitation", () => {
    const created = decideInvitation(initialInvitationState, {
      type: "CreateInvitation",
      invitationId: "ivt_test" as never,
      accountId: "acc_test" as never,
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
    const createdState = created.reduce(evolveInvitation, initialInvitationState);
    const accepted = decideInvitation(createdState, {
      type: "AcceptInvitation",
      userId: "usr_test" as never,
    });
    const acceptedState = accepted.reduce(evolveInvitation, createdState);

    expect(acceptedState.status).toBe("accepted");
    expect(acceptedState.acceptedByUserId).toBe("usr_test");
  });
});
