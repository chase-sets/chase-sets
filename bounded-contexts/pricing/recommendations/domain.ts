import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";

export type PricingRecommendationState = Readonly<{
  recommendationId: string | null;
  catalogItemId: string | null;
  sellerAccountId: string | null;
  marketPriceAmount: number | null;
  marketCurrency: string | null;
  marketObservedAt: string | null;
  recommendedListAmount: number | null;
  recommendationReason: string | null;
  publishedAt: string | null;
}>;

export const initialPricingRecommendationState: PricingRecommendationState = {
  recommendationId: null,
  catalogItemId: null,
  sellerAccountId: null,
  marketPriceAmount: null,
  marketCurrency: null,
  marketObservedAt: null,
  recommendedListAmount: null,
  recommendationReason: null,
  publishedAt: null,
};

export type RecordMarketPriceSnapshotCommand = Readonly<{
  type: "RecordMarketPriceSnapshot";
  recommendationId: string;
  catalogItemId: string;
  sellerAccountId: string;
  marketPriceAmount: number;
  marketCurrency: string;
  observedAt: string;
}>;

export type PublishRecommendationCommand = Readonly<{
  type: "PublishRecommendation";
  recommendedListAmount: number;
  reason: string;
  publishedAt: string;
}>;

export type PricingRecommendationCommand =
  | RecordMarketPriceSnapshotCommand
  | PublishRecommendationCommand;

export type MarketPriceSnapshotRecordedEvent = DomainEvent<
  "pricing.market-price-snapshot.recorded",
  Readonly<{
    recommendationId: string;
    catalogItemId: string;
    sellerAccountId: string;
    marketPriceAmount: number;
    marketCurrency: string;
    observedAt: string;
  }>
>;

export type RecommendationPublishedEvent = DomainEvent<
  "pricing.recommendation.published",
  Readonly<{
    recommendationId: string;
    recommendedListAmount: number;
    reason: string;
    publishedAt: string;
  }>
>;

export type PricingRecommendationEvent =
  | MarketPriceSnapshotRecordedEvent
  | RecommendationPublishedEvent;

export const decidePricingRecommendation: AggregateDecider<
  PricingRecommendationState,
  PricingRecommendationCommand,
  PricingRecommendationEvent
> = (state, command) => {
  switch (command.type) {
    case "RecordMarketPriceSnapshot":
      if (state.marketObservedAt === command.observedAt) {
        return [];
      }
      return [
        {
          type: "pricing.market-price-snapshot.recorded",
          data: {
            recommendationId: command.recommendationId,
            catalogItemId: command.catalogItemId,
            sellerAccountId: command.sellerAccountId,
            marketPriceAmount: command.marketPriceAmount,
            marketCurrency: command.marketCurrency,
            observedAt: command.observedAt,
          },
        },
      ];
    case "PublishRecommendation":
      if (!state.recommendationId) {
        throw new Error("Cannot publish recommendation before recording a market price snapshot.");
      }
      return [
        {
          type: "pricing.recommendation.published",
          data: {
            recommendationId: state.recommendationId,
            recommendedListAmount: command.recommendedListAmount,
            reason: command.reason,
            publishedAt: command.publishedAt,
          },
        },
      ];
    default:
      return [];
  }
};

export const evolvePricingRecommendation: AggregateEvolver<
  PricingRecommendationState,
  PricingRecommendationEvent
> = (state, event) => {
  switch (event.type) {
    case "pricing.market-price-snapshot.recorded":
      return {
        ...state,
        recommendationId: event.data.recommendationId,
        catalogItemId: event.data.catalogItemId,
        sellerAccountId: event.data.sellerAccountId,
        marketPriceAmount: event.data.marketPriceAmount,
        marketCurrency: event.data.marketCurrency,
        marketObservedAt: event.data.observedAt,
      };
    case "pricing.recommendation.published":
      return {
        ...state,
        recommendedListAmount: event.data.recommendedListAmount,
        recommendationReason: event.data.reason,
        publishedAt: event.data.publishedAt,
      };
    default:
      return state;
  }
};
