import { ROLE_PERMISSIONS, type OperatorAuthority, type OperatorAuthorityDecision } from "@chase-sets/auth-context";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import type { MembershipServices } from "./runtime";

export type OperatorGrantCreator = Readonly<{ userId: string; membershipId: string }>;
export type IdentityOperatorAuthority = OperatorAuthority &
  Readonly<{ forGrantCreator: (creator: OperatorGrantCreator) => Promise<OperatorAuthorityDecision> }>;

function denied(reason: Extract<OperatorAuthorityDecision, { kind: "denied" }>["reason"]): OperatorAuthorityDecision {
  return { kind: "denied", reason };
}

/**
 * Grants operator capabilities only to an active platform-admin Membership
 * whose aggregate belongs to the actor's user and account. The actor's own
 * `roleKey` comes from a projection and is never consulted.
 */
export function createIdentityOperatorAuthority(
  memberships: Pick<MembershipServices, "getMembershipState">,
): IdentityOperatorAuthority {
  const forGrantCreator = async ({
    userId,
    membershipId,
  }: OperatorGrantCreator): Promise<OperatorAuthorityDecision> => {
    const membership = await memberships.getMembershipState(membershipId);
    if (!membership?.id) return denied("authority-unavailable");
    if (membership.userId !== userId) return denied("membership-mismatch");
    if (membership.status !== "active") return denied("inactive");
    if (membership.roleKey !== PLATFORM_ADMIN_ROLE_KEY) return denied("not-platform-admin");
    const rolePermissions = ROLE_PERMISSIONS[PLATFORM_ADMIN_ROLE_KEY];
    if (!rolePermissions.includes("catalog.manage")) return denied("not-platform-admin");
    return {
      kind: "granted",
      membershipId: membership.id,
      roleKey: PLATFORM_ADMIN_ROLE_KEY,
      rolePermissions,
    };
  };

  const forActor: OperatorAuthority = async (actor) => {
    if (!actor.membershipId) return denied("no-membership");
    const membership = await memberships.getMembershipState(actor.membershipId);
    if (!membership?.id) return denied("authority-unavailable");
    if (membership.userId !== actor.userId || membership.accountId !== actor.accountId) {
      return denied("membership-mismatch");
    }
    if (membership.status !== "active") return denied("inactive");
    if (membership.roleKey !== PLATFORM_ADMIN_ROLE_KEY) return denied("not-platform-admin");
    return {
      kind: "granted",
      membershipId: membership.id,
      roleKey: PLATFORM_ADMIN_ROLE_KEY,
      rolePermissions: ROLE_PERMISSIONS[PLATFORM_ADMIN_ROLE_KEY],
    };
  };

  return Object.assign(forActor, { forGrantCreator });
}
