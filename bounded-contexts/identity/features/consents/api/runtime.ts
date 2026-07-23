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
import { getConsent, listConsents, type ConsentListParams } from "../read-model/queries";
import { buildConsentCurrentStateProjectionHandlers, buildConsentProjectionHandlers } from "../read-model/projection";

export type ConsentServices = Readonly<{
  commandHandler: CommandHandler<ConsentCommand, ConsentState, ConsentEvent>;
  getConsent: (consentId: string) => ReturnType<typeof getConsent>;
  getConsentState: (consentId: string) => Promise<ConsentState | null>;
  listConsents: (params?: ConsentListParams) => ReturnType<typeof listConsents>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createConsentRuntime(deps: IdentityRuntimeDeps): ConsentServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ConsentEvent>(),
    initialState: () => initialConsentState,
    evolve: evolveConsent,
    decide: decideConsent,
  });

  return {
    commandHandler,
    getConsent: (consentId) => getConsent(deps.db, consentId),
    getConsentState: async (consentId) => {
      const aggregate = await repository.load(`identity.consent-${consentId}`);
      return aggregate.state.id ? aggregate.state : null;
    },
    listConsents: (params) => listConsents(deps.db, params),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-consent-projection",
        handlers: buildConsentProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "identity-consent-current-state-projection",
        handlers: buildConsentCurrentStateProjectionHandlers(deps.db),
      }),
    ],
  };
}
