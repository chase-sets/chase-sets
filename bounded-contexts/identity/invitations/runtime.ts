import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../runtime-support";
import {
  decideInvitation,
  evolveInvitation,
  initialInvitationState,
  type InvitationCommand,
  type InvitationEvent,
  type InvitationState,
} from "./domain";
import {
  getInvitation,
  getPendingInvitationByEmail,
  listInvitations,
} from "./queries";
import { buildInvitationProjectionHandlers } from "./projection";

export type InvitationServices = Readonly<{
  commandHandler: CommandHandler<
    InvitationCommand,
    InvitationState,
    InvitationEvent
  >;
  listInvitations: (
    params?: Parameters<typeof listInvitations>[1],
  ) => ReturnType<typeof listInvitations>;
  getInvitation: (invitationId: string) => ReturnType<typeof getInvitation>;
  getPendingInvitationByEmail: (
    email: string,
  ) => ReturnType<typeof getPendingInvitationByEmail>;
  projectors: readonly Projector[];
}>;

export function createInvitationRuntime(
  deps: IdentityRuntimeDeps,
): InvitationServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<InvitationEvent>(),
      initialState: () => initialInvitationState,
      evolve: evolveInvitation,
    }),
    evolve: evolveInvitation,
    decide: decideInvitation,
  });

  return {
    commandHandler,
    listInvitations: (params) => listInvitations(deps.db, params),
    getInvitation: (invitationId) => getInvitation(deps.db, invitationId),
    getPendingInvitationByEmail: (email) => getPendingInvitationByEmail(deps.db, email),
    projectors: [
      createProjector({
        projectorName: "identity-invitation-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildInvitationProjectionHandlers(deps.db),
      }),
    ],
  };
}
