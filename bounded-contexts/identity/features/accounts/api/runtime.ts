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
import { getAccount, listAccounts, type AccountRow } from "../read-model/queries";
import { buildAccountProjectionHandlers } from "../read-model/projection";

export type AccountServices = Readonly<{
  commandHandler: CommandHandler<AccountCommand, AccountState, AccountEvent>;
  listAccounts: (params?: Parameters<typeof listAccounts>[1]) => ReturnType<typeof listAccounts>;
  getAccount: (accountId: string) => ReturnType<typeof getAccount>;
  getAccountForRead: (accountId: string) => Promise<AccountRow | null>;
  getAccountState: (accountId: string) => Promise<AccountState | null>;
  projectors: readonly ProjectionHandlerSet[];
}>;

function accountRowFromState(state: AccountState): AccountRow | null {
  if (!state.id || !state.accountType) {
    return null;
  }

  return {
    account_id: state.id,
    account_type: state.accountType,
    badges: [...state.badges],
    founder_number: state.founderNumber,
    founders_window_started_at: state.foundersWindow?.startedAt ?? null,
    founders_window_ends_at: state.foundersWindow?.endsAt ?? null,
    display_name: state.displayName,
    name: state.name ?? state.displayName,
    status: state.status,
    updated_at: "",
  };
}

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
    getAccountForRead: async (accountId) => {
      const projected = await getAccount(deps.db, accountId);
      if (projected) {
        return projected;
      }

      return accountRowFromState(await loadAccountState(accountId));
    },
    getAccountState: async (accountId) => {
      const state = await loadAccountState(accountId);
      return state.id ? state : null;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-account-projection",
        handlers: buildAccountProjectionHandlers(deps.db),
      }),
    ],
  };

  async function loadAccountState(accountId: string) {
    const aggregate = await repository.load(`identity.account-${accountId}`);
    return aggregate.state;
  }
}
