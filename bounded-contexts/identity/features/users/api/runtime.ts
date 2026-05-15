import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideUser,
  evolveUser,
  initialUserState,
  type UserCommand,
  type UserEvent,
  type UserState,
} from "../domain/domain";
import { getUser, getUserByEmail, getUserBySocialLogin, listUsers } from "../read-model/queries";
import { buildUserProjectionHandlers } from "../read-model/projection";

export type UserServices = Readonly<{
  commandHandler: CommandHandler<UserCommand, UserState, UserEvent>;
  listUsers: (params?: Parameters<typeof listUsers>[1]) => ReturnType<typeof listUsers>;
  getUser: (userId: string) => ReturnType<typeof getUser>;
  getUserByEmail: (email: string) => ReturnType<typeof getUserByEmail>;
  getUserBySocialLogin: (params: Parameters<typeof getUserBySocialLogin>[1]) => ReturnType<typeof getUserBySocialLogin>;
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
    getUserBySocialLogin: (params) => getUserBySocialLogin(deps.db, params),
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
