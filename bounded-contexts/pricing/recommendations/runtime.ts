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
import { getSellerRecommendation, listSellerRecommendations } from "./queries";
import { buildPricingRecommendationProjectionHandlers } from "./projection";
import {
  decidePricingRecommendation,
  evolvePricingRecommendation,
  initialPricingRecommendationState,
  type PricingRecommendationCommand,
  type PricingRecommendationEvent,
  type PricingRecommendationState,
} from "./domain";

type PricingRecommendationRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  ports: PricingRecommendationPorts;
}>;

export type PricingRecommendationPorts = Readonly<{
  resolveCatalogSellableUnit: (params: Readonly<Record<string, never>>) => Promise<unknown>;
  resolveMarketSupply: (params: Readonly<Record<string, never>>) => Promise<unknown>;
  reserveInventorySignal: (params: Readonly<Record<string, never>>) => Promise<unknown>;
  loadOrderSnapshot: (params: Readonly<Record<string, never>>) => Promise<unknown>;
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
      sellerAccountId: string;
      marketPriceAmount: number;
      marketCurrency: string;
      observedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recommendationId: string; version: number }>;
  publishRecommendation: (
    params: Readonly<{
      recommendationId: string;
      sellerAccountId: string;
      recommendedListAmount: number;
      reason: string;
      publishedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recommendationId: string; version: number }>;
  listSellerRecommendations: (
    params: Parameters<typeof listSellerRecommendations>[1],
  ) => ReturnType<typeof listSellerRecommendations>;
  getSellerRecommendation: (
    recommendationId: string,
    sellerAccountId: string,
  ) => ReturnType<typeof getSellerRecommendation>;
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
      await deps.ports.resolveCatalogSellableUnit({});
      await deps.ports.resolveMarketSupply({});
      await deps.ports.reserveInventorySignal({});
      await deps.ports.loadOrderSnapshot({});

      const result = await commandHandler({
        streamId: `pricing.recommendation-${params.recommendationId}`,
        command: {
          type: "RecordMarketPriceSnapshot",
          recommendationId: params.recommendationId,
          catalogItemId: params.catalogItemId,
          sellerAccountId: params.sellerAccountId,
          marketPriceAmount: params.marketPriceAmount,
          marketCurrency: params.marketCurrency,
          observedAt: params.observedAt ?? new Date().toISOString(),
        },
        context,
      });

      return { recommendationId: params.recommendationId, version: result.version };
    },
    publishRecommendation: async (params, context) => {
      const current = await getSellerRecommendation(
        deps.db,
        params.recommendationId,
        params.sellerAccountId,
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
    listSellerRecommendations: (params) => listSellerRecommendations(deps.db, params),
    getSellerRecommendation: (recommendationId, sellerAccountId) =>
      getSellerRecommendation(deps.db, recommendationId, sellerAccountId),
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
