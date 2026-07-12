import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import type { AccountServices } from "../../accounts/api/runtime";
import {
  decideFoundersCohort,
  evolveFoundersCohort,
  initialFoundersCohortState,
  type FounderNumberClaimedEvent,
  type FoundersCohortState,
  type ClaimFounderNumberCommand,
  type QualifyingActType,
} from "../domain/domain";
import { buildFoundersCohortProjectionHandlers } from "../read-model/projection";
import { getFoundersCohortCount } from "../read-model/queries";

const FOUNDERS_COHORT_STREAM_ID = "identity.founders-cohort-global";
const MAX_CONCURRENCY_RETRIES = 501;

export function createFoundersCohortRuntime(deps: IdentityRuntimeDeps, accounts: AccountServices) {
  const { commandHandler } = createAggregateCommandHandler<
    FoundersCohortState,
    ClaimFounderNumberCommand,
    FounderNumberClaimedEvent
  >({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<FounderNumberClaimedEvent>(),
    initialState: () => initialFoundersCohortState,
    evolve: evolveFoundersCohort,
    decide: decideFoundersCohort,
  });

  return {
    claimFounderNumber,
    getCount: () => getFoundersCohortCount(deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-founders-cohort-projection",
        handlers: buildFoundersCohortProjectionHandlers(deps.db),
      }),
    ],
  };

  async function claimFounderNumber(
    params: Readonly<{
      accountId: string;
      qualifyingActType: QualifyingActType;
      qualifyingActId: string;
      claimedAt: string;
    }>,
    context: EventStoreContext,
  ) {
    const account = await accounts.getAccountState(params.accountId);
    if (!account?.foundersWindow) {
      return null;
    }

    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt += 1) {
      try {
        const result = await commandHandler({
          streamId: FOUNDERS_COHORT_STREAM_ID,
          command: {
            type: "ClaimFounderNumber",
            accountId: params.accountId as AccountId,
            qualifyingActType: params.qualifyingActType,
            qualifyingActId: params.qualifyingActId,
            claimedAt: params.claimedAt,
          },
          context,
        });
        const claim = result.state.claims.find((candidate) => candidate.accountId === params.accountId) ?? null;
        if (!claim) {
          return null;
        }
        await accounts.commandHandler({
          streamId: `identity.account-${params.accountId}`,
          command: { type: "AssignAccountBadge", badgeKey: "founding-account", founderNumber: claim.founderNumber },
          context,
        });
        return claim;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "concurrency_conflict") {
          throw error;
        }
      }
    }

    throw new Error("Founder number claim could not be serialized after repeated concurrent writes.");
  }
}
