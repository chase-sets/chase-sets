import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../runtime-support";
import {
  decideAccount,
  evolveAccount,
  initialAccountState,
  type AccountCommand,
  type AccountEvent,
  type AccountState,
} from "./domain";
import { getAccount, listAccounts } from "./queries";
import { buildAccountProjectionHandlers } from "./projection";

export type AccountServices = Readonly<{
  commandHandler: CommandHandler<AccountCommand, AccountState, AccountEvent>;
  listAccounts: (
    params?: Parameters<typeof listAccounts>[1],
  ) => ReturnType<typeof listAccounts>;
  getAccount: (accountId: string) => ReturnType<typeof getAccount>;
  projectors: readonly Projector[];
}>;

export function createAccountRuntime(deps: IdentityRuntimeDeps): AccountServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<AccountEvent>(),
      initialState: () => initialAccountState,
      evolve: evolveAccount,
    }),
    evolve: evolveAccount,
    decide: decideAccount,
  });

  return {
    commandHandler,
    listAccounts: (params) => listAccounts(deps.db, params),
    getAccount: (accountId) => getAccount(deps.db, accountId),
    projectors: [
      createProjector({
        projectorName: "identity-account-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildAccountProjectionHandlers(deps.db),
      }),
    ],
  };
}
