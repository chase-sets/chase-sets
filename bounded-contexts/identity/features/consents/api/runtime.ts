import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandExecutionResult, CommandHandlerInput } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { consentActivationGuardAppendInput } from "@chase-sets/platform-policy/consent-activation-authority";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import {
  assertResolvedMemberProvenance,
  resolveConsentPolicyMemberWithProvenance,
  type ConsentActivationAuthorityReader,
} from "../domain/consent-bundle";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../domain/terms-of-service";
import {
  decideAuthorizedConsent,
  evolveConsent,
  initialConsentState,
  type AuthorizedConsentCommand,
  type RecordConsentCommand,
  type WithdrawConsentCommand,
  type ConsentEvent,
  type ConsentState,
} from "../domain/domain";
import {
  assertConsentAuthorizationForContext,
  assertConsentRecordAuthorization,
  ConsentRecordingAuthorizationError,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import { getConsent, listConsents, type ConsentListParams } from "../read-model/queries";
import { buildConsentCurrentStateProjectionHandlers, buildConsentProjectionHandlers } from "../read-model/projection";

export type ConsentServices = Readonly<{
  commandHandler: (
    input: CommandHandlerInput<WithdrawConsentCommand> & Readonly<{ authorization: ConsentRecordingAuthorization }>,
  ) => Promise<CommandExecutionResult<ConsentState, ConsentEvent>>;
  recordTermsConsent: (input: RecordTermsConsentInput) => Promise<CommandExecutionResult<ConsentState, ConsentEvent>>;
  getConsent: (consentId: string) => ReturnType<typeof getConsent>;
  getConsentState: (consentId: string) => Promise<ConsentState | null>;
  listConsents: (params?: ConsentListParams) => ReturnType<typeof listConsents>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export type RecordTermsConsentInput = Readonly<{
  streamId: string;
  consentId: ConsentId;
  subjectType: "user";
  userId: UserId;
  accountId: AccountId;
  recordedAt: string;
  context: EventStoreContext;
  authorization: ConsentRecordingAuthorization;
  activationAuthority: ConsentActivationAuthorityReader;
}>;

export function assertTermsConsentAuthorization(input: Omit<RecordTermsConsentInput, "activationAuthority">): void {
  const authorizationOnlyCommand: RecordConsentCommand = {
    type: "RecordConsent",
    consentId: input.consentId,
    subjectType: input.subjectType,
    userId: input.userId,
    accountId: input.accountId,
    policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    policyVersion: "authorization-only",
    recordedAt: input.recordedAt,
  };
  assertConsentAuthorizationForContext(input.authorization, input.context);
  if (input.subjectType !== "user") {
    throw new ConsentRecordingAuthorizationError("consent_subject_invalid", "Terms Consent must name a User subject.");
  }
  assertConsentRecordAuthorization(authorizationOnlyCommand, input.authorization);
  if (input.streamId !== `identity.consent-${input.consentId}`) {
    throw new IdentityDomainError("Terms Consent stream must match its Consent identity.");
  }
}

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
    const requested = input.command;
    if (requested.type !== "WithdrawConsent") {
      throw new IdentityDomainError("The generic Consent handler only admits WithdrawConsent.");
    }
    const command: WithdrawConsentCommand = Object.freeze({ type: "WithdrawConsent", withdrawnAt: requested.withdrawnAt });
    const context = snapshotEventStoreContext(input.context);
    assertConsentAuthorizationForContext(input.authorization, context);

    return authorizedCommandHandler({
      streamId: input.streamId,
      command: {
        command,
        authorization: input.authorization,
      },
      context,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    });
  };

  const recordTermsConsent: ConsentServices["recordTermsConsent"] = async (input) => {
    const request = Object.freeze({ ...input, context: snapshotEventStoreContext(input.context) });
    assertTermsConsentAuthorization(request);
    const member: unknown = await resolveConsentPolicyMemberWithProvenance(
      request.activationAuthority,
      TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    );
    assertResolvedMemberProvenance(member, TERMS_OF_SERVICE_CONSENT_POLICY_KEY);
    const command: RecordConsentCommand = {
      type: "RecordConsent",
      consentId: request.consentId,
      subjectType: "user",
      userId: request.userId,
      accountId: request.accountId,
      policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
      policyVersion: member.outcome.requirement.version,
      recordedAt: request.recordedAt,
    };
    const guard = consentActivationGuardAppendInput(member.guard.guard, request.context);
    if (!deps.eventStore.appendToStreams) {
      throw new Error("Terms Consent requires atomic multi-stream append.");
    }
    const loaded = await repository.load(request.streamId);
    const newEvents = decideAuthorizedConsent(loaded.state, { command, authorization: request.authorization });
    const results = await deps.eventStore.appendToStreams([
      {
        streamId: request.streamId,
        expectedVersion: loaded.version,
        context: request.context,
        events: newEvents.map((event) => ({ eventType: event.type, payload: event.data })),
      },
      guard,
    ]);
    const storedEvents = results.find((result) => result.streamId === request.streamId)?.storedEvents ?? [];
    recordCommittedEvents(storedEvents);
    return {
      state: newEvents.reduce(evolveConsent, loaded.state),
      version: storedEvents.at(-1)?.streamVersion ?? loaded.version,
      newEvents,
      storedEvents,
    };
  };

  return {
    commandHandler,
    recordTermsConsent,
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
