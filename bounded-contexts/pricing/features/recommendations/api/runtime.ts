import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getAccountRecommendation, listAccountRecommendations } from "../read-model/queries";
import { buildPricingRecommendationProjectionHandlers } from "../read-model/projection";
import {
  decidePricingRecommendation,
  evolvePricingRecommendation,
  initialPricingRecommendationState,
  type PricingRecommendationCommand,
  type PricingRecommendationEvent,
  type PricingRecommendationState,
} from "../domain/domain";

type PricingRecommendationRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type PricingRecommendationServices = Readonly<{
  commandHandler: CommandHandler<
    PricingRecommendationCommand,
    PricingRecommendationState,
    PricingRecommendationEvent
  >;
  captureMarketSnapshot: (
    params: Readonly<{
      recommendationId: string;
      catalogItemId: string;
      accountId: string;
      marketPriceAmount: number;
      marketCurrency: string;
      observedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recommendationId: string; version: number }>;
  publishRecommendation: (
    params: Readonly<{
      recommendationId: string;
      accountId: string;
      recommendedListAmount: number;
      reason: string;
      publishedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recommendationId: string; version: number }>;
  listAccountRecommendations: (
    params: Parameters<typeof listAccountRecommendations>[1],
  ) => ReturnType<typeof listAccountRecommendations>;
  getAccountRecommendation: (
    recommendationId: string,
    accountId: string,
  ) => ReturnType<typeof getAccountRecommendation>;
  projectors: readonly Projector[];
}>;

export function createPricingRecommendationRuntime(
  deps: PricingRecommendationRuntimeDeps,
): PricingRecommendationServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<PricingRecommendationEvent>(),
      initialState: () => initialPricingRecommendationState,
      evolve: evolvePricingRecommendation,
    }),
    evolve: evolvePricingRecommendation,
    decide: decidePricingRecommendation,
  });

  return {
    commandHandler,
    captureMarketSnapshot: async (params, context) => {
      const result = await commandHandler({
        streamId: `pricing.recommendation-${params.recommendationId}`,
        command: {
          type: "RecordMarketPriceSnapshot",
          recommendationId: params.recommendationId,
          catalogItemId: params.catalogItemId,
          sellerAccountId: params.accountId,
          marketPriceAmount: params.marketPriceAmount,
          marketCurrency: params.marketCurrency,
          observedAt: params.observedAt ?? new Date().toISOString(),
        },
        context,
      });

      return { recommendationId: params.recommendationId, version: result.version };
    },
    publishRecommendation: async (params, context) => {
      const current = await getAccountRecommendation(
        deps.db,
        params.recommendationId,
        params.accountId,
      );
      if (!current) {
        throw new Error("Recommendation not found.");
      }

      const result = await commandHandler({
        streamId: `pricing.recommendation-${params.recommendationId}`,
        command: {
          type: "PublishRecommendation",
          recommendedListAmount: params.recommendedListAmount,
          reason: params.reason,
          publishedAt: params.publishedAt ?? new Date().toISOString(),
        },
        context,
      });

      return { recommendationId: params.recommendationId, version: result.version };
    },
    listAccountRecommendations: (params) => listAccountRecommendations(deps.db, params),
    getAccountRecommendation: (recommendationId, accountId) =>
      getAccountRecommendation(deps.db, recommendationId, accountId),
    projectors: [
      createProjector({
        projectorName: "pricing-recommendation-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildPricingRecommendationProjectionHandlers(deps.db),
      }),
    ],
  };
}
