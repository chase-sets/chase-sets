import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  decideReleaseControlsPolicy,
  evolveReleaseControlsPolicy,
  initialReleaseControlsPolicyState,
  type PolicyActor,
  type ReleaseControlsPolicyCommand,
  type ReleaseControlsPolicyEvent,
  type ReleaseControlsPolicyState,
} from "../domain/policy";
import {
  buildReleaseControlsPolicySnapshot,
  evaluateStoredRolloutPolicy,
  type ReleaseControlsPolicySnapshot,
} from "../read-model/policy-contracts";
import type { ReleaseControlPolicyDecision, RolloutEnvironment, RolloutSubject } from "../domain/rollout";

export type ReleaseControlsPolicyServices = Readonly<{
  commandHandler: CommandHandler<ReleaseControlsPolicyCommand, ReleaseControlsPolicyState, ReleaseControlsPolicyEvent>;
  getPolicySnapshot: () => Promise<ReleaseControlsPolicySnapshot>;
  setReleaseLock: (
    params: Readonly<{
      locked: boolean;
      reason?: string | null;
      reference?: string | null;
      actor: PolicyActor;
    }>,
    context: EventStoreContext,
  ) => Promise<ReleaseControlsPolicySnapshot>;
  setRolloutPolicy: (
    params: Readonly<{
      featureKey: string;
      environment: RolloutEnvironment;
      percentage: number;
      allowSubjects?: readonly string[] | string;
      optOutSubjects?: readonly string[] | string;
      killSwitchActive?: boolean;
      reason: string;
      reference: string;
      actor: PolicyActor;
    }>,
    context: EventStoreContext,
  ) => Promise<ReleaseControlsPolicySnapshot>;
  evaluateRollout: (
    params: Readonly<{
      featureKey: string;
      environment: RolloutEnvironment;
      subject: RolloutSubject;
    }>,
  ) => Promise<ReleaseControlPolicyDecision>;
}>;

type ReleaseControlsPolicyRuntimeDeps = Readonly<{
  eventStore: EventStore;
  now?: () => Date;
}>;

const RELEASE_CONTROL_POLICY_STREAM_ID = "platform-operations.release-controls-policy";

export function createReleaseControlsPolicyRuntime(
  deps: ReleaseControlsPolicyRuntimeDeps,
): ReleaseControlsPolicyServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ReleaseControlsPolicyEvent>(),
    initialState: () => initialReleaseControlsPolicyState,
    evolve: evolveReleaseControlsPolicy,
    decide: decideReleaseControlsPolicy,
  });
  const now = deps.now ?? (() => new Date());

  async function loadState() {
    return (await repository.load(RELEASE_CONTROL_POLICY_STREAM_ID)).state;
  }

  async function apply(command: ReleaseControlsPolicyCommand, context: EventStoreContext) {
    const result = await commandHandler({
      streamId: RELEASE_CONTROL_POLICY_STREAM_ID,
      command,
      context,
      expectedVersion: "any",
    });

    return buildReleaseControlsPolicySnapshot(result.state);
  }

  return {
    commandHandler,
    async getPolicySnapshot() {
      return buildReleaseControlsPolicySnapshot(await loadState());
    },
    setReleaseLock: (params, context) =>
      apply(
        {
          type: "SetReleaseLockPolicy",
          locked: params.locked,
          reason: params.reason,
          reference: params.reference,
          actor: params.actor,
          changedAt: now().toISOString(),
        },
        context,
      ),
    setRolloutPolicy: (params, context) =>
      apply(
        {
          type: "SetFeatureRolloutPolicy",
          featureKey: params.featureKey,
          environment: params.environment,
          percentage: params.percentage,
          allowSubjects: params.allowSubjects,
          optOutSubjects: params.optOutSubjects,
          killSwitchActive: params.killSwitchActive,
          reason: params.reason,
          reference: params.reference,
          actor: params.actor,
          updatedAt: now().toISOString(),
        },
        context,
      ),
    async evaluateRollout(params) {
      return evaluateStoredRolloutPolicy(await loadState(), params);
    },
  };
}
