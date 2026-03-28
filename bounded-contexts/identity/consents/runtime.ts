import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../runtime-support";
import {
  decideConsent,
  evolveConsent,
  initialConsentState,
  type ConsentCommand,
  type ConsentEvent,
  type ConsentState,
} from "./domain";
import {
  listConsents,
  type ConsentListParams,
} from "./queries";
import { buildConsentProjectionHandlers } from "./projection";

export type ConsentServices = Readonly<{
  commandHandler: CommandHandler<ConsentCommand, ConsentState, ConsentEvent>;
  listConsents: (
    params?: ConsentListParams,
  ) => ReturnType<typeof listConsents>;
  projectors: readonly Projector[];
}>;

export function createConsentRuntime(deps: IdentityRuntimeDeps): ConsentServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ConsentEvent>(),
      initialState: () => initialConsentState,
      evolve: evolveConsent,
    }),
    evolve: evolveConsent,
    decide: decideConsent,
  });

  return {
    commandHandler,
    listConsents: (params) => listConsents(deps.db, params),
    projectors: [
      createProjector({
        projectorName: "identity-consent-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildConsentProjectionHandlers(deps.db),
      }),
    ],
  };
}
