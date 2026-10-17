import type { OperatorAuthority, OperatorAuthorityDecision } from "@chase-sets/auth-context";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import { ROLE_PERMISSIONS } from "../read-model/constants";
import type { MembershipServices } from "./runtime";

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
): OperatorAuthority {
  return async (actor) => {
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
}
