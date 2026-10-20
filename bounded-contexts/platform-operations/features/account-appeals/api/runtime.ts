import {
  createAggregateCommandHandler,
  createPassthroughDomainEventCodec,
  type EventStore,
  type EventStoreContext,
} from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createAppealableEnforcementActionResolver,
  fileAccountAppeal,
  type AccountAppealOperatorCapability,
  type AccountAppealSellerCapability,
  type AppealableEnforcementActionCapability,
} from "./access";
import {
  appealStreamId,
  decideAccountAppeal,
  evolveAccountAppeal,
  initialAccountAppealState,
  type AccountAppealEvent,
} from "../domain/domain";
import { resolveAccountAppealableAction } from "../read-model/projection";

export type AccountAppealRuntime = Readonly<{
  file: (
    capability: AccountAppealSellerCapability,
    action: AppealableEnforcementActionCapability,
    input: Parameters<typeof fileAccountAppeal>[2],
    context: EventStoreContext,
  ) => Promise<unknown>;
  resolve: ReturnType<typeof createAppealableEnforcementActionResolver>;
  startReview: (
    capability: AccountAppealOperatorCapability,
    actionId: string,
    context: EventStoreContext,
  ) => Promise<unknown>;
  recordOutcome: (
    capability: AccountAppealOperatorCapability,
    actionId: string,
    input: Readonly<{ outcome: "upheld" | "reversed" | "modified"; rationale: string; note: string }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
  withdraw: (
    capability: AccountAppealSellerCapability,
    action: AppealableEnforcementActionCapability,
    context: EventStoreContext,
  ) => Promise<unknown>;
}>;

export function createAccountAppealRuntime(db: PgQueryable, eventStore: EventStore): AccountAppealRuntime {
  const resolve = createAppealableEnforcementActionResolver({
    resolve: (id) => resolveAccountAppealableAction(db, id),
  });
  const handler = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<AccountAppealEvent>(),
    initialState: () => initialAccountAppealState,
    evolve: evolveAccountAppeal,
    decide: decideAccountAppeal,
    commitSourceContextName: "platform-operations",
  });
  return {
    resolve,
    file: (capability, action, input, context) =>
      handler.commandHandler({
        streamId: appealStreamId(action.appealableActionId),
        expectedVersion: "no_stream",
        command: fileAccountAppeal(capability, action, input),
        context,
      }),
    startReview: (capability, actionId, context) =>
      handler.commandHandler({
        streamId: appealStreamId(actionId),
        command: { type: "StartAccountAppealReview" },
        context,
      }),
    recordOutcome: (capability, actionId, input, context) =>
      handler.commandHandler({
        streamId: appealStreamId(actionId),
        command: { type: "RecordAccountAppealOutcome", ...input, operatorUserId: capability.userId },
        context,
      }),
    withdraw: (capability, action, context) =>
      handler.commandHandler({
        streamId: appealStreamId(action.appealableActionId),
        command: { type: "WithdrawAccountAppeal" },
        context,
      }),
  };
}
