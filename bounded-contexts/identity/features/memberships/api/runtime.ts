import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
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
  getMembership,
  getActiveMembershipForUserAccount,
  listMemberships,
  listMembershipsForUser,
} from "../read-model/queries";
import { buildMembershipProjectionHandlers } from "../read-model/projection";

export type MembershipServices = Readonly<{
  commandHandler: CommandHandler<
    MembershipCommand,
    MembershipState,
    MembershipEvent
  >;
  listMemberships: (
    params?: Parameters<typeof listMemberships>[1],
  ) => ReturnType<typeof listMemberships>;
  getMembership: (membershipId: string) => ReturnType<typeof getMembership>;
  getActiveMembershipForUserAccount: (
    userId: string,
    accountId: string,
  ) => ReturnType<typeof getActiveMembershipForUserAccount>;
  listMembershipsForUser: (
    userId: string,
  ) => ReturnType<typeof listMembershipsForUser>;
  projectors: readonly Projector[];
}>;

export function createMembershipRuntime(
  deps: IdentityRuntimeDeps,
): MembershipServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<MembershipEvent>(),
      initialState: () => initialMembershipState,
      evolve: evolveMembership,
    }),
    evolve: evolveMembership,
    decide: decideMembership,
  });

  return {
    commandHandler,
    listMemberships: (params) => listMemberships(deps.db, params),
    getMembership: (membershipId) => getMembership(deps.db, membershipId),
    getActiveMembershipForUserAccount: (userId, accountId) =>
      getActiveMembershipForUserAccount(deps.db, userId, accountId),
    listMembershipsForUser: (userId) => listMembershipsForUser(deps.db, userId),
    projectors: [
      createProjector({
        projectorName: "identity-membership-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildMembershipProjectionHandlers(deps.db),
      }),
    ],
  };
}
