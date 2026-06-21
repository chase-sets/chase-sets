import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideUser,
  evolveUser,
  initialUserState,
  type UserCommand,
  type UserEvent,
  type UserState,
} from "../domain/domain";
import { getUser, getUserByEmail, getUserByPhone, getUserBySocialLogin, listUsers } from "../read-model/queries";
import { buildUserProjectionHandlers } from "../read-model/projection";

export type UserServices = Readonly<{
  commandHandler: CommandHandler<UserCommand, UserState, UserEvent>;
  listUsers: (params?: Parameters<typeof listUsers>[1]) => ReturnType<typeof listUsers>;
  getUser: (userId: string) => ReturnType<typeof getUser>;
  getUserState: (userId: string) => Promise<UserState | null>;
  getUserByEmail: (email: string) => ReturnType<typeof getUserByEmail>;
  getUserByPhone: (phone: string) => ReturnType<typeof getUserByPhone>;
  getUserBySocialLogin: (params: Parameters<typeof getUserBySocialLogin>[1]) => ReturnType<typeof getUserBySocialLogin>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createUserRuntime(deps: IdentityRuntimeDeps): UserServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<UserEvent>(),
    initialState: () => initialUserState,
    evolve: evolveUser,
    decide: decideUser,
  });

  return {
    commandHandler,
    listUsers: (params) => listUsers(deps.db, params),
    getUser: (userId) => getUser(deps.db, userId),
    getUserState: async (userId) => {
      const aggregate = await repository.load(`identity.user-${userId}`);
      return aggregate.state.id ? aggregate.state : null;
    },
    getUserByEmail: (email) => getUserByEmail(deps.db, email),
    getUserByPhone: (phone) => getUserByPhone(deps.db, phone),
    getUserBySocialLogin: (params) => getUserBySocialLogin(deps.db, params),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-user-projection",
        handlers: buildUserProjectionHandlers(deps.db),
      }),
    ],
  };
}
