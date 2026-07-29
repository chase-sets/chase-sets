import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandExecutionResult, CommandHandlerInput } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  consentActivationGuardAppendInput,
  readConsentActivationAuthority,
} from "@chase-sets/platform-policy/consent-activation-authority";
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
import { assertConsentRecordingBundleAdmission } from "../domain/consent-bundle-admission";
import { getConsent, listConsents, type ConsentListParams } from "../read-model/queries";
import { buildConsentCurrentStateProjectionHandlers, buildConsentProjectionHandlers } from "../read-model/projection";
import { admitConsentRecordingActivation } from "./consent-recording-admission";

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
    if (input.command.type !== "RecordConsent") {
      return authorizedCommandHandler({
        streamId: input.streamId,
        command: { command: input.command, authorization: input.authorization },
        context,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
    }

    assertConsentRecordAuthorization(input.command, input.authorization);

    // ORDER: authorization, then publication and declared scope, then
    // activation. Each half is decided before the next input is read, so a
    // recording that publication already refuses never causes an authority read
    // -- and never reports an activation reason for a publication failure.
    //
    // The decider re-asserts this same pure rule below. That is deliberate: the
    // decider is the entrypoint registration composes directly, so the rule has
    // to live there, and asserting it here as well is what keeps the ordering
    // honest without making either site the only one that holds.
    assertConsentRecordingBundleAdmission(input.command, input.authorization);

    // The activation read happens here rather than in the decider because it
    // needs the authority's event stream. Its guard is carried into the same
    // transaction as the Consent event, so a mid-flight activation change rolls
    // the whole append back.
    const guard = await admitConsentRecordingActivation(input.command, (policyKey) =>
      readConsentActivationAuthority(deps.eventStore, policyKey),
    );

    const aggregate = await repository.load(input.streamId);
    const newEvents = decideAuthorizedConsent(aggregate.state, {
      command: input.command,
      authorization: input.authorization,
    });
    const expectedVersion = input.expectedVersion ?? (aggregate.version === 0 ? "no_stream" : aggregate.version);

    const appendToStreams = deps.eventStore.appendToStreams;
    if (!appendToStreams) {
      throw new Error("Recording Consent requires an event store that appends to many streams atomically.");
    }
    await appendToStreams.call(deps.eventStore, [
      {
        streamId: input.streamId,
        expectedVersion,
        events: newEvents.map((event) => ({ eventType: event.type, payload: event.data })),
        context,
      } satisfies AppendToStreamInput,
      consentActivationGuardAppendInput(guard, context),
    ]);

    const state = newEvents.reduce(evolveConsent, aggregate.state);
    const committed = await repository.load(input.streamId);
    return {
      state,
      version: committed.version,
      newEvents,
      storedEvents: committed.storedEvents.slice(aggregate.storedEvents.length),
    };
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
