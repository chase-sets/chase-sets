import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  type AccountId,
  type MembershipId,
  type UserId,
  createId,
} from "@chase-sets/primitives/typed-ids";
import type { RoleKey } from "../common";
import type { IdentityServices } from "../services";

async function drainProjectors(services: IdentityServices) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export type IdentityInvitationPort = Readonly<{
  getInvitation: IdentityServices["invitations"]["getInvitation"];
  acceptInvitationForUser: (params: Readonly<{
    invitationId: string;
    userId: string;
    accountId: string;
    roleKey: string;
    context: EventStoreContext;
  }>) => Promise<string>;
}>;

export function createIdentityInvitationPort(
  services: IdentityServices,
): IdentityInvitationPort {
  return {
    getInvitation: services.invitations.getInvitation,
    acceptInvitationForUser: async ({
      invitationId,
      userId,
      accountId,
      roleKey,
      context,
    }) => {
      const membershipId = createId("mbr") as MembershipId;
      await services.memberships.commandHandler({
        streamId: `identity.membership-${membershipId}`,
        command: {
          type: "GrantMembership",
          membershipId,
          userId: userId as UserId,
          accountId: accountId as AccountId,
          roleKey: roleKey as RoleKey,
        },
        context,
      });
      await services.invitations.commandHandler({
        streamId: `identity.invitation-${invitationId}`,
        command: {
          type: "AcceptInvitation",
          userId: userId as UserId,
        },
        context,
      });
      await drainProjectors(services);

      return membershipId;
    },
  };
}
