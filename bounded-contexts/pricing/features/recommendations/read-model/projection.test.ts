import { describe, expect, it } from "vitest";
import { buildPricingRecommendationProjectionHandlers } from "./projection";

describe("pricing recommendation projection", () => {
  it("upserts market snapshots and publishes recommendation fields", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingRecommendationProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["pricing.market-price-snapshot.recorded"]?.({
      type: "pricing.market-price-snapshot.recorded",
      data: {
        recommendationId: "rec_1",
        catalogItemId: "cat_1",
        sellerAccountId: "acc_1",
        marketPriceAmount: 21.5,
        marketCurrency: "USD",
        observedAt: "2026-04-30T00:00:00.000Z",
      },
    } as never);
    await handlers["pricing.recommendation.published"]?.({
      type: "pricing.recommendation.published",
      data: {
        recommendationId: "rec_1",
        recommendedListAmount: 24,
        reason: "Protect margin.",
        publishedAt: "2026-04-30T01:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.sql).toContain("INSERT INTO pricing_recommendation_pages");
    expect(calls[0]?.params).toEqual(["rec_1", "cat_1", "acc_1", 21.5, "USD", "2026-04-30T00:00:00.000Z"]);
    expect(calls[1]?.sql).toContain("UPDATE pricing_recommendation_pages");
    expect(calls[1]?.params).toEqual(["rec_1", 24, "Protect margin.", "2026-04-30T01:00:00.000Z"]);
  });

  it("upserts proposed recommendations with action, target, and status fields", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingRecommendationProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["pricing.recommendation.proposed"]?.({
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
    } as never);

    expect(calls[0]?.sql).toContain("INSERT INTO pricing_recommendation_pages");
    expect(calls[0]?.sql).toContain("action_type");
    expect(calls[0]?.sql).toContain("status");
    expect(calls[0]?.params).toEqual([
      "rec_1",
      "cat_1",
      "acc_1",
      "active-listing-price-update",
      "lst_1",
      "inv_1",
      18,
      "USD",
      "competition",
      "2026-05-09T00:00:00.000Z",
      20,
      17.99,
      "Priced one cent below the lowest competing active listing.",
      1,
    ]);
  });

  it("records applied, failed, and dismissed statuses", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingRecommendationProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["pricing.recommendation.applied"]?.({
      type: "pricing.recommendation.applied",
      data: {
        recommendationId: "rec_1",
        appliedListingId: "lst_1",
        appliedAt: "2026-05-09T01:00:00.000Z",
      },
    } as never);
    await handlers["pricing.recommendation.failed"]?.({
      type: "pricing.recommendation.failed",
      data: {
        recommendationId: "rec_2",
        errorMessage: "Fee quote changed.",
        failedAt: "2026-05-09T02:00:00.000Z",
      },
    } as never);
    await handlers["pricing.recommendation.dismissed"]?.({
      type: "pricing.recommendation.dismissed",
      data: {
        recommendationId: "rec_3",
        dismissedAt: "2026-05-09T03:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.sql).toContain("status = 'applied'");
    expect(calls[0]?.params).toEqual(["rec_1", "lst_1", "2026-05-09T01:00:00.000Z"]);
    expect(calls[1]?.sql).toContain("status = 'failed'");
    expect(calls[1]?.params).toEqual(["rec_2", "Fee quote changed.", "2026-05-09T02:00:00.000Z"]);
    expect(calls[2]?.sql).toContain("status = 'dismissed'");
    expect(calls[2]?.params).toEqual(["rec_3", "2026-05-09T03:00:00.000Z"]);
  });
});
