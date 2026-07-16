import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideMembership,
  evolveMembership,
  initialMembershipState,
  type MembershipCommand,
  type MembershipEvent,
  type MembershipState,
} from "../domain/domain";
import {
  countActiveOwnersForAccount,
  getMembership,
  getActiveMembershipForUserAccount,
  listMemberships,
  listMembershipsForUser,
} from "../read-model/queries";
import { buildMembershipProjectionHandlers } from "../read-model/projection";

export type MembershipServices = Readonly<{
  commandHandler: CommandHandler<MembershipCommand, MembershipState, MembershipEvent>;
  listMemberships: (params?: Parameters<typeof listMemberships>[1]) => ReturnType<typeof listMemberships>;
  getMembership: (membershipId: string) => ReturnType<typeof getMembership>;
  countActiveOwnersForAccount: (accountId: string) => ReturnType<typeof countActiveOwnersForAccount>;
  getMembershipState: (membershipId: string) => Promise<MembershipState | null>;
  getActiveMembershipForUserAccount: (
    userId: string,
    accountId: string,
  ) => ReturnType<typeof getActiveMembershipForUserAccount>;
  listMembershipsForUser: (userId: string) => ReturnType<typeof listMembershipsForUser>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createMembershipRuntime(deps: IdentityRuntimeDeps): MembershipServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MembershipEvent>(),
    initialState: () => initialMembershipState,
    evolve: evolveMembership,
    decide: decideMembership,
  });

  return {
    commandHandler,
    listMemberships: (params) => listMemberships(deps.db, params),
    getMembership: (membershipId) => getMembership(deps.db, membershipId),
    countActiveOwnersForAccount: (accountId) => countActiveOwnersForAccount(deps.db, accountId),
    getMembershipState: async (membershipId) => {
      const aggregate = await repository.load(`identity.membership-${membershipId}`);
      return aggregate.state.id ? aggregate.state : null;
    },
    getActiveMembershipForUserAccount: (userId, accountId) =>
      getActiveMembershipForUserAccount(deps.db, userId, accountId),
    listMembershipsForUser: (userId) => listMembershipsForUser(deps.db, userId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-membership-projection",
        handlers: buildMembershipProjectionHandlers(deps.db),
      }),
    ],
  };
}
