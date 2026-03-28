import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../runtime-support";
import {
  decideUser,
  evolveUser,
  initialUserState,
  type UserCommand,
  type UserEvent,
  type UserState,
} from "./domain";
import { getUser, getUserByEmail, listUsers } from "./queries";
import { buildUserProjectionHandlers } from "./projection";

export type UserServices = Readonly<{
  commandHandler: CommandHandler<UserCommand, UserState, UserEvent>;
  listUsers: (params?: Parameters<typeof listUsers>[1]) => ReturnType<typeof listUsers>;
  getUser: (userId: string) => ReturnType<typeof getUser>;
  getUserByEmail: (email: string) => ReturnType<typeof getUserByEmail>;
  projectors: readonly Projector[];
}>;

export function createUserRuntime(deps: IdentityRuntimeDeps): UserServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<UserEvent>(),
      initialState: () => initialUserState,
      evolve: evolveUser,
    }),
    evolve: evolveUser,
    decide: decideUser,
  });

  return {
    commandHandler,
    listUsers: (params) => listUsers(deps.db, params),
    getUser: (userId) => getUser(deps.db, userId),
    getUserByEmail: (email) => getUserByEmail(deps.db, email),
    projectors: [
      createProjector({
        projectorName: "identity-user-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildUserProjectionHandlers(deps.db),
      }),
    ],
  };
}
