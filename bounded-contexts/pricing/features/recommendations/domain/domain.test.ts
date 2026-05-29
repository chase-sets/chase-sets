import { describe, expect, it } from "vitest";
import {
  decidePricingRecommendation,
  evolvePricingRecommendation,
  initialPricingRecommendationState,
  type PricingRecommendationEvent,
} from "./domain";

function evolve(events: readonly PricingRecommendationEvent[]) {
  return events.reduce(evolvePricingRecommendation, initialPricingRecommendationState);
}

describe("pricing recommendation domain", () => {
  it("records market snapshots and publishes recommendations", () => {
    const recorded = decidePricingRecommendation(initialPricingRecommendationState, {
      type: "RecordMarketPriceSnapshot",
      recommendationId: "rec_1",
      catalogItemId: "cat_1",
      sellerAccountId: "acc_1",
      marketPriceAmount: 21.5,
      marketCurrency: "USD",
      observedAt: "2026-04-30T00:00:00.000Z",
    });
    const published = decidePricingRecommendation(evolve(recorded), {
      type: "PublishRecommendation",
      recommendedListAmount: 24,
      reason: "Above market to protect margin.",
      publishedAt: "2026-04-30T01:00:00.000Z",
    });

    expect(evolve([...recorded, ...published])).toMatchObject({
      recommendationId: "rec_1",
      marketPriceAmount: 21.5,
      recommendedListAmount: 24,
      recommendationReason: "Above market to protect margin.",
    });
  });

  it("is idempotent for duplicate observations and rejects publish before snapshot", () => {
    const recordedState = evolve([
      {
        type: "pricing.market-price-snapshot.recorded",
        data: {
          recommendationId: "rec_1",
          catalogItemId: "cat_1",
          sellerAccountId: "acc_1",
          marketPriceAmount: 21.5,
          marketCurrency: "USD",
          observedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    ]);

    expect(
      decidePricingRecommendation(recordedState, {
        type: "RecordMarketPriceSnapshot",
        recommendationId: "rec_1",
        catalogItemId: "cat_1",
        sellerAccountId: "acc_1",
        marketPriceAmount: 21.5,
        marketCurrency: "USD",
        observedAt: "2026-04-30T00:00:00.000Z",
      }),
    ).toEqual([]);
    expect(() =>
      decidePricingRecommendation(initialPricingRecommendationState, {
        type: "PublishRecommendation",
        recommendedListAmount: 24,
        reason: "Missing snapshot.",
        publishedAt: "2026-04-30T01:00:00.000Z",
      }),
    ).toThrow("Cannot publish recommendation before recording a market price snapshot.");
  });

  it("keeps dismissed recommendations out of the queue until the proposal changes", () => {
    const dismissedState = evolve([
      {
        type: "pricing.recommendation.proposed",
        data: {
          recommendationId: "rec_1",
          catalogItemId: "cat_1",
          sellerAccountId: "acc_1",
          actionType: "active-listing-price-update",
          listingId: "lst_1",
          inventoryItemId: "inv_1",
          marketPriceAmount: 18,
          marketCurrency: "USD",
          marketSignalType: "competition",
          currentPriceAmount: 20,
          recommendedListAmount: 17.99,
          reason: "Priced one cent below the lowest competing active listing.",
          quantityCap: 1,
          observedAt: "2026-05-09T00:00:00.000Z",
        },
      },
      {
        type: "pricing.recommendation.dismissed",
        data: {
          recommendationId: "rec_1",
          dismissedAt: "2026-05-09T00:05:00.000Z",
        },
      },
    ]);

    expect(
      decidePricingRecommendation(dismissedState, {
        type: "ProposeRecommendation",
        recommendationId: "rec_1",
        catalogItemId: "cat_1",
        sellerAccountId: "acc_1",
        actionType: "active-listing-price-update",
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        marketPriceAmount: 18,
        marketCurrency: "USD",
        marketSignalType: "competition",
        currentPriceAmount: 20,
        recommendedListAmount: 17.99,
        reason: "Priced one cent below the lowest competing active listing.",
        quantityCap: 1,
        observedAt: "2026-05-09T01:00:00.000Z",
      }),
    ).toEqual([]);

    expect(
      decidePricingRecommendation(dismissedState, {
        type: "ProposeRecommendation",
        recommendationId: "rec_1",
        catalogItemId: "cat_1",
        sellerAccountId: "acc_1",
        actionType: "active-listing-price-update",
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        marketPriceAmount: 17,
        marketCurrency: "USD",
        marketSignalType: "competition",
        currentPriceAmount: 20,
        recommendedListAmount: 16.99,
        reason: "Priced one cent below the lowest competing active listing.",
        quantityCap: 1,
        observedAt: "2026-05-09T01:00:00.000Z",
      }),
    ).toHaveLength(1);
  });

  it("ignores failure commands after a recommendation is already applied", () => {
    const appliedState = evolve([
      {
        type: "pricing.recommendation.proposed",
        data: {
          recommendationId: "rec_1",
          catalogItemId: "cat_1",
          sellerAccountId: "acc_1",
          actionType: "active-listing-price-update",
          listingId: "lst_1",
          inventoryItemId: "inv_1",
          marketPriceAmount: 18,
          marketCurrency: "USD",
          marketSignalType: "competition",
          currentPriceAmount: 20,
          recommendedListAmount: 17.99,
          reason: "Priced one cent below the lowest competing active listing.",
          quantityCap: 1,
          observedAt: "2026-05-09T00:00:00.000Z",
        },
      },
      {
        type: "pricing.recommendation.applied",
        data: {
          recommendationId: "rec_1",
          appliedListingId: "lst_1",
          appliedAt: "2026-05-09T00:05:00.000Z",
        },
      },
    ]);

    expect(
      decidePricingRecommendation(appliedState, {
        type: "MarkRecommendationFailed",
        errorMessage: "Lease was lost after the side effect succeeded.",
        failedAt: "2026-05-09T00:06:00.000Z",
      }),
    ).toEqual([]);
  });
});
