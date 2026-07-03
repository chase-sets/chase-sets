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
      assignmentAuthority: { type: "system" },
    });
    const grantedState = granted.reduce(evolveMembership, initialMembershipState);
    const revoked = decideMembership(grantedState, { type: "RevokeMembership" });
    const revokedState = revoked.reduce(evolveMembership, grantedState);

    expect(grantedState.roleKey).toBe("manager");
    expect(revokedState.status).toBe("revoked");
  });

  it("rejects platform-admin grants without platform bootstrap authority", () => {
    expect(() =>
      decideMembership(initialMembershipState, {
        type: "GrantMembership",
        membershipId: "mbr_test" as never,
        userId: "usr_test" as never,
        accountId: "acc_test" as never,
        roleKey: "platform-admin",
        assignmentAuthority: { type: "actor", roleKey: "owner" },
      }),
    ).toThrow("Platform-admin can only be assigned by platform bootstrap.");

    expect(() =>
      decideMembership(initialMembershipState, {
        type: "GrantMembership",
        membershipId: "mbr_test" as never,
        userId: "usr_test" as never,
        accountId: "acc_test" as never,
        roleKey: "platform-admin",
        assignmentAuthority: { type: "system" },
      }),
    ).toThrow("Platform-admin can only be assigned by platform bootstrap.");
  });

  it("allows explicit platform bootstrap to grant platform-admin", () => {
    const granted = decideMembership(initialMembershipState, {
      type: "GrantMembership",
      membershipId: "mbr_test" as never,
      userId: "usr_test" as never,
      accountId: "acc_test" as never,
      roleKey: "platform-admin",
      assignmentAuthority: { type: "platform-bootstrap" },
    });

    expect(granted[0]).toMatchObject({
      type: "identity.membership.granted",
      data: { roleKey: "platform-admin" },
    });
  });

  it("rejects role changes above the actor role", () => {
    const granted = decideMembership(initialMembershipState, {
      type: "GrantMembership",
      membershipId: "mbr_test" as never,
      userId: "usr_test" as never,
      accountId: "acc_test" as never,
      roleKey: "viewer",
      assignmentAuthority: { type: "system" },
    });
    const grantedState = granted.reduce(evolveMembership, initialMembershipState);

    expect(() =>
      decideMembership(grantedState, {
        type: "ChangeMembershipRole",
        roleKey: "owner",
        assignmentAuthority: { type: "actor", roleKey: "manager" },
      }),
    ).toThrow("Cannot assign a role above the actor's role.");
  });
});
