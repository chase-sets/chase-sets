import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideApiKey,
  evolveApiKey,
  initialApiKeyState,
  type ApiKeyCommand,
  type ApiKeyEvent,
  type ApiKeyState,
} from "../domain/domain";
import { getApiKey, listApiKeys } from "../read-model/queries";
import { buildApiKeyProjectionHandlers } from "../read-model/projection";

export type ApiKeyServices = Readonly<{
  commandHandler: CommandHandler<ApiKeyCommand, ApiKeyState, ApiKeyEvent>;
  listApiKeys: (
    params?: Parameters<typeof listApiKeys>[1],
  ) => ReturnType<typeof listApiKeys>;
  getApiKey: (apiKeyId: string) => ReturnType<typeof getApiKey>;
  projectors: readonly Projector[];
}>;

export function createApiKeyRuntime(deps: IdentityRuntimeDeps): ApiKeyServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ApiKeyEvent>(),
      initialState: () => initialApiKeyState,
      evolve: evolveApiKey,
    }),
    evolve: evolveApiKey,
    decide: decideApiKey,
  });

  return {
    commandHandler,
    listApiKeys: (params) => listApiKeys(deps.db, params),
    getApiKey: (apiKeyId) => getApiKey(deps.db, apiKeyId),
    projectors: [
      createProjector({
        projectorName: "identity-api-key-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildApiKeyProjectionHandlers(deps.db),
      }),
    ],
  };
}
