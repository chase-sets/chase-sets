import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { LoadedAggregate } from "@chase-sets/event-core/aggregate-repository";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  decideRepricingPolicy,
  evolveRepricingPolicy,
  initialRepricingPolicyState,
  type RepricingPolicyCommand,
  type RepricingPolicyEvent,
  type RepricingPolicyState,
} from "../domain/domain";
import { buildRepricingPolicyProjectionHandlers, repricingPolicyStreamId } from "../read-model/projection";
import {
  getInventoryAcquisitionCostAmount,
  getAccountRepricingPolicy,
  getRepricingPolicyAssignmentForListing,
  listAccountRepricingPolicies,
  listRepricingPolicyAssignments,
  type RepricingPolicyAssignmentRow,
  type RepricingPolicyRecord,
} from "../read-model/queries";
import {
  decideRepricingHalt,
  evolveRepricingHalt,
  initialRepricingHaltState,
  repricingHaltStreamId,
  type RepricingHaltState,
  type RepricingHaltEvent,
} from "../domain/halt";
import { buildRepricingHaltProjectionHandlers } from "../read-model/halt-projection";
import { getRepricingBudget, listRepricingCategories, previewRepricingScope } from "../read-model/controls";

type RepricingPolicyRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
}>;

export class PolicyControlValidationError extends Error {}

export type RepricingPolicyServices = Readonly<{
  commandHandler: CommandHandler<RepricingPolicyCommand, RepricingPolicyState, RepricingPolicyEvent>;
  getAccountRepricingPolicy: (
    params: Readonly<{ accountId: string; policyId: string }>,
  ) => Promise<RepricingPolicyRecord | null>;
  loadOwnedRepricingPolicy: (
    policyId: string,
    accountId: string,
  ) => Promise<LoadedAggregate<RepricingPolicyState, RepricingPolicyEvent> | null>;
  executeOwnedRepricingPolicy: (
    input: Readonly<{
      policyId: string;
      accountId: string;
      command: Exclude<RepricingPolicyCommand, { type: "CreateRepricingPolicy" }>;
      context: EventStoreContext;
    }>,
  ) => Promise<RepricingPolicyState | null>;
  getHalt: (accountId: string) => Promise<RepricingHaltState>;
  setHalt: (accountId: string, engaged: boolean, context: EventStoreContext) => Promise<RepricingHaltState>;
  getBudget: (accountId: string, day: string) => ReturnType<typeof getRepricingBudget>;
  listCategories: (accountId: string) => ReturnType<typeof listRepricingCategories>;
  previewScope: (input: Parameters<typeof previewRepricingScope>[1]) => ReturnType<typeof previewRepricingScope>;
  listAccountRepricingPolicies: (
    params: Readonly<{ accountId: string; includeDeleted?: boolean }>,
  ) => Promise<readonly RepricingPolicyRecord[]>;
  listRepricingPolicyAssignments: (
    params: Readonly<{ accountId?: string; policyId?: string }>,
  ) => Promise<readonly RepricingPolicyAssignmentRow[]>;
  getRepricingPolicyAssignmentForListing: (listingId: string) => Promise<RepricingPolicyAssignmentRow | null>;
  getInventoryAcquisitionCostAmount: (
    params: Readonly<{ sellerAccountId: string; catalogItemId: string; productId: string }>,
  ) => Promise<string | null>;
  streamIdForPolicy: (policyId: string) => string;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createRepricingPolicyRuntime(deps: RepricingPolicyRuntimeDeps): RepricingPolicyServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<RepricingPolicyEvent>(),
    initialState: () => initialRepricingPolicyState,
    evolve: evolveRepricingPolicy,
    decide: decideRepricingPolicy,
  });
  const halt = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<RepricingHaltEvent>(),
    initialState: () => initialRepricingHaltState,
    evolve: evolveRepricingHalt,
    decide: decideRepricingHalt,
  });
  const loadOwnedRepricingPolicy: RepricingPolicyServices["loadOwnedRepricingPolicy"] = async (policyId, accountId) => {
    const loaded = await repository.load(repricingPolicyStreamId(policyId));
    return loaded.state.accountId === accountId ? loaded : null;
  };

  return {
    commandHandler,
    getAccountRepricingPolicy: (params) => getAccountRepricingPolicy(deps.db, params),
    loadOwnedRepricingPolicy,
    executeOwnedRepricingPolicy: async ({ policyId, accountId, command, context }) => {
      const loaded = await loadOwnedRepricingPolicy(policyId, accountId);
      if (!loaded) return null;
      try {
        decideRepricingPolicy(loaded.state, command);
      } catch (error) {
        throw new PolicyControlValidationError(error instanceof Error ? error.message : "Invalid policy command.");
      }
      return (
        await commandHandler({
          streamId: repricingPolicyStreamId(policyId),
          command,
          context,
          expectedVersion: loaded.version,
        })
      ).state;
    },
    getHalt: async (accountId) => (await halt.repository.load(repricingHaltStreamId(accountId))).state,
    setHalt: async (accountId, engaged, context) =>
      (
        await halt.commandHandler({
          streamId: repricingHaltStreamId(accountId),
          command: { engaged, changedAt: new Date().toISOString() },
          context,
        })
      ).state,
    getBudget: (accountId, day) => getRepricingBudget(deps.db, accountId, day),
    listCategories: (accountId) => listRepricingCategories(deps.db, accountId),
    previewScope: (input) => previewRepricingScope(deps.db, input),
    listAccountRepricingPolicies: (params) => listAccountRepricingPolicies(deps.db, params),
    listRepricingPolicyAssignments: (params) => listRepricingPolicyAssignments(deps.db, params),
    getRepricingPolicyAssignmentForListing: (listingId) => getRepricingPolicyAssignmentForListing(deps.db, listingId),
    getInventoryAcquisitionCostAmount: (params) => getInventoryAcquisitionCostAmount(deps.db, params),
    streamIdForPolicy: repricingPolicyStreamId,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "pricing-repricing-policy-projection",
        handlers: buildRepricingPolicyProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "pricing-repricing-halt-projection",
        handlers: buildRepricingHaltProjectionHandlers(deps.db),
      }),
    ],
  };
}
