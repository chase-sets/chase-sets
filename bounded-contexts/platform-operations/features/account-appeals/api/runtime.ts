import { createAggregateCommandHandler, createPassthroughDomainEventCodec, type EventStore, type EventStoreContext } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { configureAccountAppealRegistryLookup, fileAccountAppeal, type AccountAppealSellerCapability, type AppealableEnforcementActionCapability } from "./access";
import { appealStreamId, decideAccountAppeal, evolveAccountAppeal, initialAccountAppealState, type AccountAppealCommand, type AccountAppealEvent } from "../domain/domain";
import { resolveAccountAppealableAction } from "../read-model/projection";

export type AccountAppealRuntime = Readonly<{
  file: (capability: AccountAppealSellerCapability, action: AppealableEnforcementActionCapability, input: Parameters<typeof fileAccountAppeal>[2], context: EventStoreContext) => Promise<unknown>;
  command: (actionId: string, command: AccountAppealCommand, context: EventStoreContext) => Promise<unknown>;
}>;

export function createAccountAppealRuntime(db: PgQueryable, eventStore: EventStore): AccountAppealRuntime {
  configureAccountAppealRegistryLookup({ resolve: (id) => resolveAccountAppealableAction(db, id) });
  const handler = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<AccountAppealEvent>(),
    initialState: () => initialAccountAppealState,
    evolve: evolveAccountAppeal,
    decide: decideAccountAppeal,
    commitSourceContextName: "platform-operations",
  });
  return {
    file: (capability, action, input, context) =>
      handler.commandHandler({ streamId: appealStreamId(action.appealableActionId), expectedVersion: "no_stream", command: fileAccountAppeal(capability, action, input), context }),
    command: (actionId, command, context) =>
      handler.commandHandler({ streamId: appealStreamId(actionId), command, context }),
  };
}
