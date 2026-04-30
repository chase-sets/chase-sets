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
    expect(calls[0]?.params).toEqual([
      "rec_1",
      "cat_1",
      "acc_1",
      21.5,
      "USD",
      "2026-04-30T00:00:00.000Z",
    ]);
    expect(calls[1]?.sql).toContain("UPDATE pricing_recommendation_pages");
    expect(calls[1]?.params).toEqual([
      "rec_1",
      24,
      "Protect margin.",
      "2026-04-30T01:00:00.000Z",
    ]);
  });
});
