import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandExecutionResult, CommandHandlerInput } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideAuthorizedConsent,
  evolveConsent,
  initialConsentState,
  type AuthorizedConsentCommand,
  type ConsentCommand,
  type ConsentEvent,
  type ConsentState,
} from "../domain/domain";
import {
  assertConsentAuthorizationForContext,
  assertConsentRecordAuthorization,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import { getConsent, listConsents, type ConsentListParams } from "../read-model/queries";
import { buildConsentCurrentStateProjectionHandlers, buildConsentProjectionHandlers } from "../read-model/projection";

export type ConsentServices = Readonly<{
  commandHandler: (
    input: CommandHandlerInput<ConsentCommand> & Readonly<{ authorization: ConsentRecordingAuthorization }>,
  ) => Promise<CommandExecutionResult<ConsentState, ConsentEvent>>;
  getConsent: (consentId: string) => ReturnType<typeof getConsent>;
  getConsentState: (consentId: string) => Promise<ConsentState | null>;
  listConsents: (params?: ConsentListParams) => ReturnType<typeof listConsents>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createConsentRuntime(deps: IdentityRuntimeDeps): ConsentServices {
  const { commandHandler: authorizedCommandHandler, repository } = createAggregateCommandHandler<
    ConsentState,
    AuthorizedConsentCommand,
    ConsentEvent
  >({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ConsentEvent>(),
    initialState: () => initialConsentState,
    evolve: evolveConsent,
    decide: decideAuthorizedConsent,
  });

  const commandHandler: ConsentServices["commandHandler"] = async (input) => {
    const context = snapshotEventStoreContext(input.context);
    assertConsentAuthorizationForContext(input.authorization, context);
    if (input.command.type === "RecordConsent") {
      assertConsentRecordAuthorization(input.command, input.authorization);
    }

    return authorizedCommandHandler({
      streamId: input.streamId,
      command: {
        command: input.command,
        authorization: input.authorization,
      },
      context,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    });
  };

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

function snapshotEventStoreContext(context: EventStoreContext): EventStoreContext {
  return Object.freeze({
    tenantId: context.tenantId,
    audit: Object.freeze({
      performedByUserId: context.audit.performedByUserId,
      forAccountId: context.audit.forAccountId,
    }),
    ...(context.trace === undefined ? {} : { trace: Object.freeze({ ...context.trace }) }),
  });
}
