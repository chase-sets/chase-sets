import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideAccount,
  evolveAccount,
  initialAccountState,
  type AccountCommand,
  type AccountEvent,
  type AccountState,
} from "../domain/domain";
import { getAccount, listAccounts } from "../read-model/queries";
import { buildAccountProjectionHandlers } from "../read-model/projection";

export type AccountServices = Readonly<{
  commandHandler: CommandHandler<AccountCommand, AccountState, AccountEvent>;
  listAccounts: (params?: Parameters<typeof listAccounts>[1]) => ReturnType<typeof listAccounts>;
  getAccount: (accountId: string) => ReturnType<typeof getAccount>;
  getAccountState: (accountId: string) => Promise<AccountState | null>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createAccountRuntime(deps: IdentityRuntimeDeps): AccountServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<AccountEvent>(),
    initialState: () => initialAccountState,
    evolve: evolveAccount,
    decide: decideAccount,
  });

  return {
    commandHandler,
    listAccounts: (params) => listAccounts(deps.db, params),
    getAccount: (accountId) => getAccount(deps.db, accountId),
    getAccountState: async (accountId) => {
      const aggregate = await repository.load(`identity.account-${accountId}`);
      return aggregate.state.id ? aggregate.state : null;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-account-projection",
        handlers: buildAccountProjectionHandlers(deps.db),
      }),
    ],
  };
}
