import { describe, expect, it } from "vitest";
import { decideMembership, evolveMembership, initialMembershipState } from "./domain";

describe("membership domain", () => {
  it("grants and revokes a membership", () => {
    const granted = decideMembership(initialMembershipState, {
      type: "GrantMembership",
      membershipId: "mbr_test" as never,
      userId: "usr_test" as never,
      accountId: "acc_test" as never,
      roleKey: "manager",
    });
    const grantedState = granted.reduce(evolveMembership, initialMembershipState);
    const revoked = decideMembership(grantedState, { type: "RevokeMembership" });
    const revokedState = revoked.reduce(evolveMembership, grantedState);

    expect(grantedState.roleKey).toBe("manager");
    expect(revokedState.status).toBe("revoked");
  });
});
