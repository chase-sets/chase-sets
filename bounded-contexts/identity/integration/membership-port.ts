import type { IdentityServices } from "../services";

export type IdentityAuthMembership = Readonly<{
  membershipId: string;
  accountId: string;
  roleKey: string;
  status: string;
}>;

export type IdentityMembershipPort = Readonly<{
  listActiveMembershipsForUser: (userId: string) => Promise<readonly IdentityAuthMembership[]>;
  getActiveMembershipForUserAccount: (
    userId: string,
    accountId: string,
  ) => ReturnType<IdentityServices["memberships"]["getActiveMembershipForUserAccount"]>;
}>;

async function listActiveMembershipsForUser(
  services: IdentityServices,
  userId: string,
): Promise<readonly IdentityAuthMembership[]> {
  const memberships = await services.memberships.listMembershipsForUser(userId);
  return memberships
    .filter((membership) => membership.status === "active")
    .map((membership) => ({
      membershipId: membership.membership_id,
      accountId: membership.account_id,
      roleKey: membership.role_key,
      status: membership.status,
    }));
}

export function createIdentityMembershipPort(
  services: IdentityServices,
): IdentityMembershipPort {
  return {
    listActiveMembershipsForUser: (userId) =>
      listActiveMembershipsForUser(services, userId),
    getActiveMembershipForUserAccount: (userId, accountId) =>
      services.memberships.getActiveMembershipForUserAccount(userId, accountId),
  };
}
