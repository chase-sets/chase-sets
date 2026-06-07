import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildPackagePlan,
  defaultPostagePolicy,
  type PackagePlan,
  type PostagePolicy,
  type ProductMeasureSnapshot,
  type ProductPhysicalFlag,
  type ShippingOption,
} from "@chase-sets/product-measures";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  decidePostagePolicy,
  evolvePostagePolicy,
  initialPostagePolicyState,
  type PostagePolicyCommand,
  type PostagePolicyEvent,
  type PostagePolicyState,
} from "../domain/domain";
import { buildPostagePolicyProjectionHandlers } from "../read-model/projection";
import { getActivePostagePolicy, getPostagePolicy, listPostagePolicies } from "../read-model/queries";

type PostagePolicyRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type PostagePolicyPreviewRequest = Readonly<{
  policy: Partial<PostagePolicy>;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  quantity: number;
  unitLengthInches: number;
  unitWidthInches: number;
  unitHeightInches: number;
  unitWeightOunces: number;
  physicalFlags: readonly ProductPhysicalFlag[];
}>;

export type PostagePolicyServices = Readonly<{
  commandHandler: CommandHandler<PostagePolicyCommand, PostagePolicyState, PostagePolicyEvent>;
  createPolicy: (
    params: Omit<Extract<PostagePolicyCommand, { type: "CreatePostagePolicy" }>, "type" | "policyId">,
    context: EventStoreContext,
  ) => Promise<{ policyId: string; version: number }>;
  revisePolicy: (
    policyId: string,
    params: Omit<Extract<PostagePolicyCommand, { type: "RevisePostagePolicy" }>, "type">,
    context: EventStoreContext,
  ) => Promise<{ policyId: string; version: number }>;
  activatePolicy: (
    policyId: string,
    params: Omit<Extract<PostagePolicyCommand, { type: "ActivatePostagePolicy" }>, "type">,
    context: EventStoreContext,
  ) => Promise<{ policyId: string; version: number }>;
  retirePolicy: (
    policyId: string,
    params: Omit<Extract<PostagePolicyCommand, { type: "RetirePostagePolicy" }>, "type">,
    context: EventStoreContext,
  ) => Promise<{ policyId: string; version: number }>;
  clonePolicy: (
    policyId: string,
    params: Readonly<{
      label: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
      createdByUserId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ policyId: string; version: number }>;
  previewPolicy: (params: PostagePolicyPreviewRequest) => PackagePlan;
  listPolicies: (params: Readonly<{ limit?: number; offset?: number }>) => ReturnType<typeof listPostagePolicies>;
  getPolicy: (policyId: string) => ReturnType<typeof getPostagePolicy>;
  getActivePolicy: (effectiveAt?: string) => Promise<PostagePolicy>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPostagePolicyRuntime(deps: PostagePolicyRuntimeDeps): PostagePolicyServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<PostagePolicyEvent>(),
      initialState: () => initialPostagePolicyState,
      evolve: evolvePostagePolicy,
    }),
    evolve: evolvePostagePolicy,
    decide: decidePostagePolicy,
  });

  return {
    commandHandler,
    async createPolicy(params, context) {
      const policyId = createId("opp");
      const result = await commandHandler({
        streamId: `ordering.postage-policy-${policyId}`,
        command: {
          type: "CreatePostagePolicy",
          policyId,
          ...params,
        },
        context,
      });
      return { policyId, version: result.version };
    },
    async revisePolicy(policyId, params, context) {
      const result = await commandHandler({
        streamId: `ordering.postage-policy-${policyId}`,
        command: {
          type: "RevisePostagePolicy",
          ...params,
        },
        context,
      });
      return { policyId, version: result.version };
    },
    async activatePolicy(policyId, params, context) {
      const currentActive = await getActivePostagePolicy(deps.db);
      const result = await commandHandler({
        streamId: `ordering.postage-policy-${policyId}`,
        command: {
          type: "ActivatePostagePolicy",
          ...params,
        },
        context,
      });
      if (currentActive && currentActive.policy_id !== policyId) {
        await commandHandler({
          streamId: `ordering.postage-policy-${currentActive.policy_id}`,
          command: {
            type: "RetirePostagePolicy",
            retiredByUserId: params.activatedByUserId,
            retirementReason: `Replaced by postage policy ${policyId}.`,
          },
          context,
        });
      }
      return { policyId, version: result.version };
    },
    async retirePolicy(policyId, params, context) {
      const result = await commandHandler({
        streamId: `ordering.postage-policy-${policyId}`,
        command: {
          type: "RetirePostagePolicy",
          ...params,
        },
        context,
      });
      return { policyId, version: result.version };
    },
    async clonePolicy(policyId, params, context) {
      const existing = await getPostagePolicy(deps.db, policyId);
      if (!existing) {
        throw new Error("Postage policy not found.");
      }
      const clonedPolicyId = createId("opp");
      const result = await commandHandler({
        streamId: `ordering.postage-policy-${clonedPolicyId}`,
        command: {
          type: "CreatePostagePolicy",
          policyId: clonedPolicyId,
          label: params.label,
          payload: existing.payload,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
          createdByUserId: params.createdByUserId,
        },
        context,
      });
      return { policyId: clonedPolicyId, version: result.version };
    },
    previewPolicy(params) {
      const measure: ProductMeasureSnapshot = {
        catalogItemId: "preview-catalog-item",
        productId: "preview-product",
        selectedOptions: [],
        measureVersion: "preview",
        unitLengthInches: params.unitLengthInches,
        unitWidthInches: params.unitWidthInches,
        unitHeightInches: params.unitHeightInches,
        unitWeightOunces: params.unitWeightOunces,
        physicalFlags: params.physicalFlags,
        stackBehavior: "stackable-thickness",
        source: "product-override",
        confidence: "measured",
      };

      return buildPackagePlan({
        shippingOption: params.shippingOption,
        itemSubtotalAmount: params.itemSubtotalAmount,
        postagePolicy: params.policy,
        lines: [
          {
            productId: "preview-product",
            quantity: params.quantity,
            measure,
          },
        ],
      });
    },
    listPolicies: (params) => listPostagePolicies(deps.db, params),
    getPolicy: (policyId) => getPostagePolicy(deps.db, policyId),
    async getActivePolicy(effectiveAt) {
      return (await getActivePostagePolicy(deps.db, effectiveAt))?.payload ?? defaultPostagePolicy;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "ordering-postage-policy-projection",
        handlers: buildPostagePolicyProjectionHandlers(deps.db),
      }),
    ],
  };
}
