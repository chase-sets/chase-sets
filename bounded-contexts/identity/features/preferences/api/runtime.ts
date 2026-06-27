import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideUserPreferences,
  evolveUserPreferences,
  initialUserPreferencesState,
  userPreferencesFor,
  type UserPreferencesCommand,
  type UserPreferencesEvent,
  type UserPreferencesState,
} from "../domain/domain";
import { getUserPreferences } from "../read-model/queries";
import { buildUserPreferencesProjectionHandlers } from "../read-model/projection";

export type UserPreferencesServices = Readonly<{
  commandHandler: CommandHandler<UserPreferencesCommand, UserPreferencesState, UserPreferencesEvent>;
  getUserPreferences: (userId: string) => ReturnType<typeof getUserPreferences>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createUserPreferencesRuntime(deps: IdentityRuntimeDeps): UserPreferencesServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<UserPreferencesEvent>(),
    initialState: () => initialUserPreferencesState,
    evolve: evolveUserPreferences,
    decide: decideUserPreferences,
  });

  return {
    commandHandler,
    getUserPreferences: async (userId) => {
      const aggregate = await repository.load(`identity.user-preferences-${userId}`);
      if (aggregate.state.userId) {
        return userPreferencesFor(aggregate.state.userId, aggregate.state);
      }

      return getUserPreferences(deps.db, userId);
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-user-preferences-projection",
        handlers: buildUserPreferencesProjectionHandlers(deps.db),
      }),
    ],
  };
}
