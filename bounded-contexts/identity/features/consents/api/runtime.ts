import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideConsent,
  evolveConsent,
  initialConsentState,
  type ConsentCommand,
  type ConsentEvent,
  type ConsentState,
} from "../domain/domain";
import { listConsents, type ConsentListParams } from "../read-model/queries";
import { buildConsentProjectionHandlers } from "../read-model/projection";

export type ConsentServices = Readonly<{
  commandHandler: CommandHandler<ConsentCommand, ConsentState, ConsentEvent>;
  listConsents: (params?: ConsentListParams) => ReturnType<typeof listConsents>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createConsentRuntime(deps: IdentityRuntimeDeps): ConsentServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ConsentEvent>(),
    initialState: () => initialConsentState,
    evolve: evolveConsent,
    decide: decideConsent,
  });

  return {
    commandHandler,
    listConsents: (params) => listConsents(deps.db, params),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-consent-projection",
        handlers: buildConsentProjectionHandlers(deps.db),
      }),
    ],
  };
}
