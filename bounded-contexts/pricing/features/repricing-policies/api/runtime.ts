import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { LoadedAggregate } from "@chase-sets/event-core/aggregate-repository";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingConfigurationWriter } from "./configuration";
import {
  RepricingConfigurationConflict,
  repricingPolicyConfigurationKey,
  repricingHaltConfigurationKey,
} from "./configuration";
import type {
  RepricingPolicyReceipt,
  RepricingHaltReceipt,
  RepricingConfigurationStatus,
} from "../domain/configuration-receipt";
import { parseRepricingPolicyState, parseRepricingHaltState } from "../domain/configuration-state";
import { canonicalJson } from "../../repricing-engine/api/dry-run";
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
import type { GoalAdoption } from "../../forecast-ledger/domain/adoption-gate";
import {
  getRepricingAuthoringFacts,
  getRepricingBudget,
  listRepricingCategories,
  previewRepricingScope,
  type RepricingAuthoringPrerequisites,
} from "../read-model/controls";

type RepricingPolicyRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  /** The Adoption Gate over the registered goal versions, owned by the Forecast Ledger. */
  goalAdoptions: () => Promise<readonly GoalAdoption[]>;
  configuration: RepricingConfigurationWriter;
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
      requestKey?: string;
      requestFingerprint?: string;
      expectedPolicyVersion?: number;
    }>,
  ) => Promise<RepricingPolicyReceipt | null>;
  getHalt: (accountId: string) => Promise<RepricingHaltState>;
  setHalt: (
    accountId: string,
    engaged: boolean,
    context: EventStoreContext,
    requestKey?: string,
  ) => Promise<RepricingHaltReceipt>;
  getPolicyConfigurationStatus: (
    accountId: string,
    policyId: string,
  ) => Promise<RepricingConfigurationStatus<RepricingPolicyState>>;
  getHaltConfigurationStatus: (accountId: string) => Promise<RepricingConfigurationStatus<RepricingHaltState>>;
  retryPolicyConfiguration: (
    accountId: string,
    policyId: string,
    requestKey: string,
    fingerprint: string,
  ) => Promise<RepricingPolicyReceipt | null>;
  listConfigurationRequests: RepricingConfigurationWriter["list"];
  getBudget: (accountId: string, day: string) => ReturnType<typeof getRepricingBudget>;
  listCategories: (accountId: string) => ReturnType<typeof listRepricingCategories>;
  getAuthoringPrerequisites: (accountId: string) => Promise<RepricingAuthoringPrerequisites>;
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
    listConfigurationRequests: deps.configuration.list.bind(deps.configuration),
    getAccountRepricingPolicy: (params) => getAccountRepricingPolicy(deps.db, params),
    loadOwnedRepricingPolicy,
    executeOwnedRepricingPolicy: async ({
      policyId,
      accountId,
      command,
      context,
      requestKey,
      requestFingerprint,
      expectedPolicyVersion,
    }) => {
      const {
        pausedAt: _paused,
        resumedAt: _resumed,
        deletedAt: _deleted,
        revisedAt: _revised,
        ...semantic
      } = {
        pausedAt: undefined,
        resumedAt: undefined,
        deletedAt: undefined,
        revisedAt: undefined,
        ...command,
      };
      return deps.configuration.request({
        key: repricingPolicyConfigurationKey(accountId, policyId),
        accountId,
        requestKey,
        fingerprint: requestFingerprint ?? canonicalJson(semantic),
        parseState: parseRepricingPolicyState,
        prepare: async () => {
          const loaded = await loadOwnedRepricingPolicy(policyId, accountId);
          if (!loaded) return null;
          if (expectedPolicyVersion !== undefined && loaded.version !== expectedPolicyVersion)
            throw new RepricingConfigurationConflict("Installed policy changed before request acceptance.");
          let events: readonly RepricingPolicyEvent[];
          try {
            events = decideRepricingPolicy(loaded.state, command);
          } catch (error) {
            throw new PolicyControlValidationError("Invalid policy command.", { cause: error });
          }
          return {
            append: {
              streamId: repricingPolicyStreamId(policyId),
              context,
              expectedVersion: loaded.version,
              wakeSourceContextName: "pricing",
              events: events.map(createPassthroughDomainEventCodec<RepricingPolicyEvent>().encode),
            },
            state: events.reduce(evolveRepricingPolicy, loaded.state),
          };
        },
      });
    },
    getHalt: async (accountId) => (await halt.repository.load(repricingHaltStreamId(accountId))).state,
    setHalt: async (accountId, engaged, context, requestKey) => {
      const result = await deps.configuration.request({
        key: repricingHaltConfigurationKey(accountId),
        accountId,
        requestKey,
        fingerprint: JSON.stringify({ engaged }),
        parseState: parseRepricingHaltState,
        prepare: async () => {
          const loaded = await halt.repository.load(repricingHaltStreamId(accountId));
          const events = decideRepricingHalt(loaded.state, { engaged, changedAt: new Date().toISOString() });
          return {
            append: {
              streamId: repricingHaltStreamId(accountId),
              context,
              expectedVersion: loaded.version,
              wakeSourceContextName: "pricing",
              events: events.map(createPassthroughDomainEventCodec<RepricingHaltEvent>().encode),
            },
            state: events.reduce(evolveRepricingHalt, loaded.state),
          };
        },
      });
      if (!result) throw new Error("Repricing Halt request was not recorded.");
      return result;
    },
    getPolicyConfigurationStatus: async (accountId, policyId) => {
      const installed = await loadOwnedRepricingPolicy(policyId, accountId);
      const status = await deps.configuration.status(
        repricingPolicyConfigurationKey(accountId, policyId),
        parseRepricingPolicyState,
      );
      if (status.request) return { ...status, installedState: status.installedState ?? installed?.state ?? null };
      return { ...status, installedState: installed?.state ?? null, installedRevision: installed?.version ?? 0, requestedRevision: installed?.version ?? 0 };
    },
    getHaltConfigurationStatus: async (accountId) => {
      const installed = await halt.repository.load(repricingHaltStreamId(accountId));
      const status = await deps.configuration.status(repricingHaltConfigurationKey(accountId), parseRepricingHaltState);
      if (status.request) return { ...status, installedState: status.installedState ?? installed.state };
      return { ...status, installedState: installed.state, installedRevision: installed.version, requestedRevision: installed.version };
    },
    retryPolicyConfiguration: (accountId, policyId, requestKey, fingerprint) =>
      deps.configuration.retry(
        repricingPolicyConfigurationKey(accountId, policyId),
        accountId,
        requestKey,
        fingerprint,
        parseRepricingPolicyState,
      ),
    getBudget: (accountId, day) => getRepricingBudget(deps.db, accountId, day),
    listCategories: (accountId) => listRepricingCategories(deps.db, accountId),
    getAuthoringPrerequisites: async (accountId) => {
      const [facts, adoptions] = await Promise.all([
        getRepricingAuthoringFacts(deps.db, accountId),
        deps.goalAdoptions(),
      ]);
      return { ...facts, goalAdoption: adoptions.map(({ grades: _grades, ...adoption }) => adoption) };
    },
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
