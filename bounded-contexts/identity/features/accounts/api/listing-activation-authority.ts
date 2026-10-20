import type { OwnerStreamReservation } from "@chase-sets/event-core/owner-seal";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

type VersionedAccount = Readonly<{
  state: Readonly<{ status: string }>;
  version: number;
}>;
type VersionedMembership = Readonly<{
  state: Readonly<{
    userId: string | null;
    accountId: string | null;
    roleKey: string | null;
    status: string;
  }>;
  version: number;
}>;
type ActiveMembership = Readonly<{
  membership_id: string;
  role_permissions: readonly string[];
}>;

export type ListingActivationIdentityReader = Readonly<{
  accounts: Readonly<{
    getAccountStateWithVersion?: (accountId: string) => Promise<VersionedAccount | null>;
  }>;
  memberships: Readonly<{
    getActiveMembershipForUserAccount: (userId: string, accountId: string) => Promise<ActiveMembership | null>;
    getMembershipStateWithVersion?: (membershipId: string) => Promise<VersionedMembership | null>;
  }>;
}>;

export type ListingActivationManageAuthority = Readonly<{
  authorizeManage(
    input: Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ): Promise<Readonly<{ value: boolean; reservations: readonly OwnerStreamReservation[] }>>;
}>;

/** Identity-owned owner authority for channel-only Listing commands. */
export function createListingActivationAuthority(
  identity: ListingActivationIdentityReader,
): ListingActivationManageAuthority {
  return {
    authorizeManage: async ({ accountId }, context) => {
      const accountLoaded = await identity.accounts.getAccountStateWithVersion?.(accountId);
      const userId = String(context.audit.performedByUserId);
      const membership = await identity.memberships.getActiveMembershipForUserAccount(userId, accountId);
      const membershipLoaded = membership
        ? await identity.memberships.getMembershipStateWithVersion?.(membership.membership_id)
        : null;
      if (!membership || !membershipLoaded || !accountLoaded) return { value: false, reservations: [] };
      const allowed =
        accountLoaded.state.status === "active" &&
        membershipLoaded.state.status === "active" &&
        membershipLoaded.state.userId === userId &&
        membershipLoaded.state.accountId === accountId &&
        (membershipLoaded.state.roleKey === "owner" || membershipLoaded.state.roleKey === "manager") &&
        membership.role_permissions.includes("listings.manage");
      if (!allowed) return { value: false, reservations: [] };
      return {
        value: true,
        reservations: [
          reservation("identity", `identity.account-${accountId}`, accountLoaded.version, async () => {
            const current = await identity.accounts.getAccountStateWithVersion?.(accountId);
            if (!current || current.version !== accountLoaded.version || current.state.status !== "active") {
              throw new Error("Identity account authority changed.");
            }
          }),
          reservation(
            "identity",
            `identity.membership-${membership.membership_id}`,
            membershipLoaded.version,
            async () => {
              const current = await identity.memberships.getMembershipStateWithVersion?.(membership.membership_id);
              if (
                !current ||
                current.version !== membershipLoaded.version ||
                current.state.status !== "active" ||
                current.state.userId !== userId ||
                current.state.accountId !== accountId ||
                (current.state.roleKey !== "owner" && current.state.roleKey !== "manager")
              ) {
                throw new Error("Identity membership authority changed.");
              }
            },
          ),
        ],
      };
    },
  };
}

function reservation(
  ownerContext: string,
  streamId: string,
  expectedVersion: number,
  assertCurrent: () => Promise<void>,
): OwnerStreamReservation {
  return { ownerContext, streamId, expectedVersion, assertCurrent };
}
