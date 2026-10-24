import {
  createAggregateCommandHandler,
  createPassthroughDomainEventCodec,
  type CommandExecutionResult,
  type EventStore,
  type EventStoreContext,
} from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EnforcementActionId, ListingEnforcementActionId } from "@chase-sets/primitives/typed-ids";
import {
  createAppealableEnforcementActionResolver,
  assertAccountAppealFileCapability,
  assertAccountAppealOperatorCapability,
  fileAccountAppeal,
  type AccountAppealFileCapability,
  type AccountAppealOperatorCapability,
  type AccountAppealSellerCapability,
  type AppealableEnforcementActionCapability,
  type ResolutionResult,
} from "./access";
import {
  appealStreamId,
  decideAccountAppeal,
  evolveAccountAppeal,
  initialAccountAppealState,
  type AccountAppealEvent,
  type AccountAppealState,
  type AccountAppealCommand,
  type AccountAppealId,
  type AppealOutcome,
} from "../domain/domain";
import { readAppealableEnforcementAction } from "../read-model/projection";

export type AccountAppealActionId = EnforcementActionId | ListingEnforcementActionId;
export type AccountAppealCommandResult = CommandExecutionResult<AccountAppealState, AccountAppealEvent>;
export type AccountAppealRuntime = Readonly<{
  resolve: (capability: AccountAppealSellerCapability, actionId: AccountAppealActionId) => Promise<ResolutionResult>;
  file: (
    capability: AccountAppealFileCapability,
    action: AppealableEnforcementActionCapability,
    input: Readonly<{ statement: string; appealId?: AccountAppealId }>,
    context: EventStoreContext,
  ) => Promise<AccountAppealCommandResult>;
  startReview: (
    capability: AccountAppealOperatorCapability,
    actionId: AccountAppealActionId,
    context: EventStoreContext,
  ) => Promise<AccountAppealCommandResult>;
  recordOutcome: (
    capability: AccountAppealOperatorCapability,
    actionId: AccountAppealActionId,
    input: Readonly<{ outcome: AppealOutcome; rationale: string; note: string }>,
    context: EventStoreContext,
  ) => Promise<AccountAppealCommandResult>;
  withdraw: (
    capability: AccountAppealFileCapability,
    action: AppealableEnforcementActionCapability,
    context: EventStoreContext,
  ) => Promise<AccountAppealCommandResult>;
}>;

export function createAccountAppealRuntime(db: PgQueryable, eventStore: EventStore): AccountAppealRuntime {
  const resolve = createAppealableEnforcementActionResolver({
    resolve: (actionId, ownerAccountId) =>
      readAppealableEnforcementAction(db, { appealableActionId: actionId, ownerAccountId }),
  });
  const handler = createAggregateCommandHandler<AccountAppealState, AccountAppealCommand, AccountAppealEvent>({
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
    startReview: (capability, actionId, context) => {
      assertAccountAppealOperatorCapability(capability);
      return handler.commandHandler({
        streamId: appealStreamId(actionId),
        command: { type: "StartAccountAppealReview" },
        context,
      });
    },
    recordOutcome: (capability, actionId, input, context) => {
      assertAccountAppealOperatorCapability(capability);
      return handler.commandHandler({
        streamId: appealStreamId(actionId),
        command: { type: "RecordAccountAppealOutcome", ...input, operatorUserId: capability.userId },
        context,
      });
    },
    withdraw: (capability, action, context) => {
      assertAccountAppealFileCapability(capability);
      return handler.commandHandler({
        streamId: appealStreamId(action.appealableActionId),
        command: { type: "WithdrawAccountAppeal" },
        context,
      });
    },
  };
}
