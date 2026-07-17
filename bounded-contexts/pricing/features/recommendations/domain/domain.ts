import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";

export type PricingRecommendationState = Readonly<{
  recommendationId: string | null;
  catalogItemId: string | null;
  sellerAccountId: string | null;
  actionType: PricingRecommendationActionType | null;
  status: PricingRecommendationStatus | null;
  listingId: string | null;
  inventoryItemId: string | null;
  marketPriceAmount: number | null;
  marketCurrency: string | null;
  marketSignalType: PricingMarketSignalType | null;
  marketObservedAt: string | null;
  currentPriceAmount: number | null;
  recommendedListAmount: number | null;
  recommendationReason: string | null;
  quantityCap: number | null;
  appliedListingId: string | null;
  lastError: string | null;
  publishedAt: string | null;
}>;

export type PricingRecommendationActionType =
  | "active-listing-price-update"
  | "draft-listing-price-update"
  | "draft-listing-create";

export type PricingRecommendationStatus = "proposed" | "applied" | "dismissed" | "failed";

export type PricingMarketSignalType = "market-estimate" | "competition" | "offer";

export const initialPricingRecommendationState: PricingRecommendationState = {
  recommendationId: null,
  catalogItemId: null,
  sellerAccountId: null,
  actionType: null,
  status: null,
  listingId: null,
  inventoryItemId: null,
  marketPriceAmount: null,
  marketCurrency: null,
  marketSignalType: null,
  marketObservedAt: null,
  currentPriceAmount: null,
  recommendedListAmount: null,
  recommendationReason: null,
  quantityCap: null,
  appliedListingId: null,
  lastError: null,
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

export type ProposeRecommendationCommand = Readonly<{
  type: "ProposeRecommendation";
  recommendationId: string;
  catalogItemId: string;
  sellerAccountId: string;
  actionType: PricingRecommendationActionType;
  listingId?: string | null;
  inventoryItemId?: string | null;
  marketPriceAmount: number;
  marketCurrency: string;
  marketSignalType: PricingMarketSignalType;
  currentPriceAmount?: number | null;
  recommendedListAmount: number;
  reason: string;
  quantityCap?: number | null;
  observedAt: string;
}>;

export type MarkRecommendationAppliedCommand = Readonly<{
  type: "MarkRecommendationApplied";
  appliedListingId: string;
  appliedAt: string;
}>;

export type MarkRecommendationFailedCommand = Readonly<{
  type: "MarkRecommendationFailed";
  errorMessage: string;
  failedAt: string;
}>;

export type DismissRecommendationCommand = Readonly<{
  type: "DismissRecommendation";
  dismissedAt: string;
}>;

export type PricingRecommendationCommand =
  | RecordMarketPriceSnapshotCommand
  | PublishRecommendationCommand
  | ProposeRecommendationCommand
  | MarkRecommendationAppliedCommand
  | MarkRecommendationFailedCommand
  | DismissRecommendationCommand;

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

export type RecommendationProposedEvent = DomainEvent<
  "pricing.recommendation.proposed",
  Readonly<{
    recommendationId: string;
    catalogItemId: string;
    sellerAccountId: string;
    actionType: PricingRecommendationActionType;
    listingId: string | null;
    inventoryItemId: string | null;
    marketPriceAmount: number;
    marketCurrency: string;
    marketSignalType: PricingMarketSignalType;
    currentPriceAmount: number | null;
    recommendedListAmount: number;
    reason: string;
    quantityCap: number | null;
    observedAt: string;
  }>
>;

export type RecommendationAppliedEvent = DomainEvent<
  "pricing.recommendation.applied",
  Readonly<{
    recommendationId: string;
    appliedListingId: string;
    appliedAt: string;
  }>
>;

export type RecommendationFailedEvent = DomainEvent<
  "pricing.recommendation.failed",
  Readonly<{
    recommendationId: string;
    errorMessage: string;
    failedAt: string;
  }>
>;

export type RecommendationDismissedEvent = DomainEvent<
  "pricing.recommendation.dismissed",
  Readonly<{
    recommendationId: string;
    dismissedAt: string;
  }>
>;

export type PricingRecommendationEvent =
  | MarketPriceSnapshotRecordedEvent
  | RecommendationPublishedEvent
  | RecommendationProposedEvent
  | RecommendationAppliedEvent
  | RecommendationFailedEvent
  | RecommendationDismissedEvent;

function normalizeActionType(value: PricingRecommendationActionType) {
  switch (value) {
    case "active-listing-price-update":
    case "draft-listing-price-update":
    case "draft-listing-create":
      return value;
    default:
      throw new Error("Recommendation action type is not supported.");
  }
}

function normalizeSignalType(value: PricingMarketSignalType) {
  return value === "market-estimate" || value === "offer" ? value : "competition";
}

function optionalText(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function requiredText(value: string, message: string) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(message);
  }
  return normalized;
}

function positiveAmount(value: number, message: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
  return Number(value.toFixed(2));
}

function positiveQuantity(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Recommendation quantity cap must be a positive whole number.");
  }
  return value;
}

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
    case "ProposeRecommendation": {
      const recommendedListAmount = positiveAmount(
        command.recommendedListAmount,
        "Recommended list amount must be positive.",
      );
      const marketPriceAmount = positiveAmount(command.marketPriceAmount, "Market price amount must be positive.");
      const listingId = optionalText(command.listingId);
      const inventoryItemId = optionalText(command.inventoryItemId);
      if (
        (state.status === "dismissed" || state.status === "applied") &&
        state.actionType === command.actionType &&
        state.listingId === listingId &&
        state.inventoryItemId === inventoryItemId &&
        state.recommendedListAmount === recommendedListAmount &&
        state.marketPriceAmount === marketPriceAmount
      ) {
        return [];
      }

      return [
        {
          type: "pricing.recommendation.proposed",
          data: {
            recommendationId: requiredText(command.recommendationId, "Recommendation id is required."),
            catalogItemId: requiredText(command.catalogItemId, "Catalog item is required."),
            sellerAccountId: requiredText(command.sellerAccountId, "Seller account is required."),
            actionType: normalizeActionType(command.actionType),
            listingId,
            inventoryItemId,
            marketPriceAmount,
            marketCurrency: requiredText(command.marketCurrency, "Market currency is required.").toUpperCase(),
            marketSignalType: normalizeSignalType(command.marketSignalType),
            currentPriceAmount:
              command.currentPriceAmount === null || command.currentPriceAmount === undefined
                ? null
                : positiveAmount(command.currentPriceAmount, "Current price amount must be positive."),
            recommendedListAmount,
            reason: requiredText(command.reason, "Recommendation reason is required."),
            quantityCap: positiveQuantity(command.quantityCap),
            observedAt: requiredText(command.observedAt, "Observation time is required."),
          },
        },
      ];
    }
    case "MarkRecommendationApplied":
      if (!state.recommendationId) {
        throw new Error("Recommendation must exist before it can be applied.");
      }
      if (state.status === "applied") {
        return [];
      }
      return [
        {
          type: "pricing.recommendation.applied",
          data: {
            recommendationId: state.recommendationId,
            appliedListingId: requiredText(command.appliedListingId, "Applied listing id is required."),
            appliedAt: requiredText(command.appliedAt, "Applied time is required."),
          },
        },
      ];
    case "MarkRecommendationFailed":
      if (!state.recommendationId) {
        throw new Error("Recommendation must exist before failure can be recorded.");
      }
      if (state.status === "applied" || state.status === "dismissed") {
        return [];
      }
      return [
        {
          type: "pricing.recommendation.failed",
          data: {
            recommendationId: state.recommendationId,
            errorMessage: requiredText(command.errorMessage, "Failure message is required."),
            failedAt: requiredText(command.failedAt, "Failure time is required."),
          },
        },
      ];
    case "DismissRecommendation":
      if (!state.recommendationId) {
        throw new Error("Recommendation must exist before it can be dismissed.");
      }
      if (state.status === "dismissed") {
        return [];
      }
      return [
        {
          type: "pricing.recommendation.dismissed",
          data: {
            recommendationId: state.recommendationId,
            dismissedAt: requiredText(command.dismissedAt, "Dismissal time is required."),
          },
        },
      ];
    default:
      return [];
  }
};

export const evolvePricingRecommendation: AggregateEvolver<PricingRecommendationState, PricingRecommendationEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "pricing.market-price-snapshot.recorded":
      return {
        ...state,
        recommendationId: event.data.recommendationId,
        catalogItemId: event.data.catalogItemId,
        sellerAccountId: event.data.sellerAccountId,
        actionType: state.actionType,
        status: state.status,
        listingId: state.listingId,
        inventoryItemId: state.inventoryItemId,
        marketPriceAmount: event.data.marketPriceAmount,
        marketCurrency: event.data.marketCurrency,
        marketSignalType: state.marketSignalType,
        marketObservedAt: event.data.observedAt,
        currentPriceAmount: state.currentPriceAmount,
        recommendedListAmount: state.recommendedListAmount,
        recommendationReason: state.recommendationReason,
        quantityCap: state.quantityCap,
        appliedListingId: state.appliedListingId,
        lastError: state.lastError,
      };
    case "pricing.recommendation.published":
      return {
        ...state,
        recommendedListAmount: event.data.recommendedListAmount,
        recommendationReason: event.data.reason,
        publishedAt: event.data.publishedAt,
      };
    case "pricing.recommendation.proposed":
      return {
        ...state,
        recommendationId: event.data.recommendationId,
        catalogItemId: event.data.catalogItemId,
        sellerAccountId: event.data.sellerAccountId,
        actionType: event.data.actionType,
        status: "proposed",
        listingId: event.data.listingId,
        inventoryItemId: event.data.inventoryItemId,
        marketPriceAmount: event.data.marketPriceAmount,
        marketCurrency: event.data.marketCurrency,
        marketSignalType: event.data.marketSignalType,
        marketObservedAt: event.data.observedAt,
        currentPriceAmount: event.data.currentPriceAmount,
        recommendedListAmount: event.data.recommendedListAmount,
        recommendationReason: event.data.reason,
        quantityCap: event.data.quantityCap,
        appliedListingId: null,
        lastError: null,
        publishedAt: event.data.observedAt,
      };
    case "pricing.recommendation.applied":
      return {
        ...state,
        status: "applied",
        appliedListingId: event.data.appliedListingId,
        lastError: null,
        publishedAt: event.data.appliedAt,
      };
    case "pricing.recommendation.failed":
      return {
        ...state,
        status: "failed",
        lastError: event.data.errorMessage,
        publishedAt: event.data.failedAt,
      };
    case "pricing.recommendation.dismissed":
      return {
        ...state,
        status: "dismissed",
        publishedAt: event.data.dismissedAt,
      };
    default:
      return state;
  }
};
