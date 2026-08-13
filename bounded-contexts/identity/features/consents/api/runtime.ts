import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandExecutionResult, CommandHandlerInput } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  consentActivationGuardAppendInput,
  type ValidatedConsentActivationGuard,
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
  type RecordConsentCommand,
} from "../domain/domain";
import {
  assertConsentAuthorizationForContext,
  assertConsentRecordAuthorization,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import { getConsent, listConsents, type ConsentListParams } from "../read-model/queries";
import { buildConsentCurrentStateProjectionHandlers, buildConsentProjectionHandlers } from "../read-model/projection";

/**
 * One guard-carried Consent recording: a brand-new Consent stream, plus the
 * zero-event version guards for every Consent Activation Authority the
 * resolution that produced this version actually read.
 *
 * A recording-specific member rather than a widened `CommandHandlerInput`:
 * carrying activation guards is a property of consent recording, not of every
 * command every context sends, and generalizing it would put a Consent concern
 * into the shared command-handler contract for no caller that needs it.
 */
export type RecordGuardedConsentInput = Readonly<{
  streamId: string;
  command: RecordConsentCommand;
  context: EventStoreContext;
  authorization: ConsentRecordingAuthorization;
  /** Ordered as the resolution read them. Empty is a value: nothing was read, so nothing is guarded. */
  activationGuards: readonly ValidatedConsentActivationGuard[];
}>;

export type RecordGuardedConsentResult = Readonly<{
  version: number;
  state: ConsentState;
  events: readonly ConsentEvent[];
}>;

export type ConsentServices = Readonly<{
  commandHandler: (
    input: CommandHandlerInput<ConsentCommand> & Readonly<{ authorization: ConsentRecordingAuthorization }>,
  ) => Promise<CommandExecutionResult<ConsentState, ConsentEvent>>;
  /**
   * Records a Consent and its activation guards in ONE all-or-nothing
   * `appendToStreams` transaction. If any guarded authority moved between the
   * resolution that produced this version and this append, the whole
   * transaction rolls back and no Consent is recorded at a version that is no
   * longer the active one.
   */
  recordGuardedConsent: (input: RecordGuardedConsentInput) => Promise<RecordGuardedConsentResult>;
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

  const recordGuardedConsent: ConsentServices["recordGuardedConsent"] = async (input) => {
    const context = snapshotEventStoreContext(input.context);
    // The same two authorization checks the generic handler applies, in the
    // same order. Composing the decider directly to reach one shared
    // transaction must never be a way around the write-authorization boundary.
    assertConsentAuthorizationForContext(input.authorization, context);
    assertConsentRecordAuthorization(input.command, input.authorization);

    const eventStore = deps.eventStore;
    if (!eventStore.appendToStreams) {
      throw new Error(
        "Guard-carried Consent recording requires an event store that appends to many streams atomically.",
      );
    }

    const events = decideAuthorizedConsent(initialConsentState, {
      command: input.command,
      authorization: input.authorization,
    });

    // The Consent id is minted per attempt, so its stream must not exist. A
    // `no_stream` guard is the honest expected version and makes a colliding id
    // a conflict rather than an append onto somebody else's history.
    const results = await eventStore.appendToStreams([
      {
        streamId: input.streamId,
        expectedVersion: "no_stream",
        events: events.map((event) => ({ eventType: event.type, payload: event.data })),
        context,
      },
      ...input.activationGuards.map((guard) => consentActivationGuardAppendInput(guard, context)),
    ]);

    const storedEvents = results.find((result) => result.streamId === input.streamId)?.storedEvents ?? [];
    return {
      version: storedEvents.length === 0 ? 0 : storedEvents[storedEvents.length - 1].streamVersion,
      state: events.reduce(evolveConsent, initialConsentState),
      events,
    };
  };

  return {
    commandHandler,
    recordGuardedConsent,
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
