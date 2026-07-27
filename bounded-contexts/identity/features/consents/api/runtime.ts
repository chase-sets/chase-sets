import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler, CommandHandlerInput } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import {
  consentActivationGuardAppendInput,
  readConsentActivationAuthority,
} from "@chase-sets/platform-policy/consent-activation-authority";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  assertConsentVersionIsActivated,
  assertConsentVersionIsPublished,
  consentBundleMemberActivationPolicyKey,
  identityConsentPublicationCorpus,
  isConsentBundleMemberPolicyKey,
} from "../domain/consent-bundle";
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

/**
 * The Consent write surface, and the single chokepoint every path that records
 * a Consent goes through -- the registration constructor, the authenticated
 * acceptance route, the development seed, the production bootstrap and the
 * admin-QA fixtures all call this `commandHandler` and none of them can reach
 * the aggregate around it.
 *
 * Recording a Consent for a Consent Bundle member is admitted here, not merely
 * checked: the member's activation is read from its Consent Activation
 * Authority stream, and the guard token minted by that same read is carried
 * into the append. A version that is not activated is rejected before anything
 * is written, and an activation that changes between that read and the commit
 * rejects the whole append rather than recording against a version that just
 * stopped being active.
 */
export function createConsentRuntime(deps: IdentityRuntimeDeps): ConsentServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ConsentEvent>(),
    initialState: () => initialConsentState,
    evolve: evolveConsent,
    decide: decideConsent,
  });

  const admittedCommandHandler: CommandHandler<ConsentCommand, ConsentState, ConsentEvent> = async (input) => {
    if (input.command.type !== "RecordConsent" || !isConsentBundleMemberPolicyKey(input.command.policyKey)) {
      return commandHandler(input);
    }

    const { policyKey, policyVersion } = input.command;
    // Publication first, and deliberately: a version no artifact publishes is
    // the more fundamental failure, and naming it that way is more useful than
    // reporting it as "not activated". The decider re-asserts the same rule, so
    // this ordering is a diagnostic choice, not the only place it holds.
    assertConsentVersionIsPublished(policyKey, policyVersion, identityConsentPublicationCorpus);

    // One authoritative read: activation state, active version and the guard
    // token all come out of the same replay, so the version this admission
    // accepts can never describe a different moment than the token that
    // protects the append.
    const snapshot = await readConsentActivationAuthority(
      deps.eventStore,
      consentBundleMemberActivationPolicyKey(policyKey),
    );
    assertConsentVersionIsActivated(policyKey, policyVersion, snapshot);

    const guarded: CommandHandlerInput<ConsentCommand> = {
      ...input,
      guards: [consentActivationGuardAppendInput(snapshot.guard, input.context)],
    };
    return commandHandler(guarded);
  };

  return {
    commandHandler: admittedCommandHandler,
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
