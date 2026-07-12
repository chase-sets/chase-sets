import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
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
  getRepricingPolicy,
  getRepricingPolicyAssignmentForListing,
  listAccountRepricingPolicies,
  listRepricingPolicyAssignments,
  type RepricingPolicyAssignmentRow,
  type RepricingPolicyRecord,
} from "../read-model/queries";

type RepricingPolicyRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
}>;

export type RepricingPolicyServices = Readonly<{
  commandHandler: CommandHandler<RepricingPolicyCommand, RepricingPolicyState, RepricingPolicyEvent>;
  getRepricingPolicy: (policyId: string) => Promise<RepricingPolicyRecord | null>;
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
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<RepricingPolicyEvent>(),
    initialState: () => initialRepricingPolicyState,
    evolve: evolveRepricingPolicy,
    decide: decideRepricingPolicy,
  });

  return {
    commandHandler,
    getRepricingPolicy: (policyId) => getRepricingPolicy(deps.db, policyId),
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
    ],
  };
}
