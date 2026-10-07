import { describe, expect, it } from "vitest";
import { calculateDemandCurve } from "../domain/demand-curve/curve";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE as policy } from "../domain/demand-curve-policy";
import type { CurveSale } from "../domain/demand-curve/curve-builder-registry";

const asOf = "2026-09-01T15:00:00.000Z";
const sales: CurveSale[] = Array.from({ length: 30 }, (_, index) => ({
  price: index % 2 ? 6 : 10,
  condition: index % 2 ? "Lightly Played" : "Near Mint",
  soldAt: new Date(Date.parse(asOf) - index * 86_400_000).toISOString(),
  variant: "Normal",
  language: "English",
  source: "external-comp",
  coverage: "complete",
}));
const sourceWeights = { platformVerifiedTrade: 1, platformTrade: 0.7, externalComp: 0.4 };
const sampleGuard = { minimumEffectiveSampleSize: 2, maximumParticipantWeightShare: 0.3 };
const supply = {
  status: "observed" as const,
  ownSellerExclusionApplied: false,
  asks: [
    { condition: "Near Mint", deliveredAmount: 10, sellerOrdinal: 1 },
    { condition: "Moderately Played", deliveredAmount: 5, sellerOrdinal: 1 },
    { condition: "Moderately Played", deliveredAmount: 6, sellerOrdinal: 2 },
  ],
};

describe("capture-local scaled pooled supply", () => {
  it("scales every condition before deduplicating seller ordinals", () => {
    const result = calculateDemandCurve({
      sales,
      siblingMarketPrices: new Map(),
      targetCondition: "Near Mint",
      asOf,
      supply,
      policy,
      sourceWeights,
      ...sampleGuard,
      minimumSample: 3,
      trimPercentile: 0,
    });
    expect(result?.points.some((point) => point.competingSellerCount === 1)).toBe(true);
    expect(result?.points.every((point) => point.storeWinShare === 1 / ((point.competingSellerCount ?? 0) + 1))).toBe(
      true,
    );
  });

  it("a scarce worse condition does not forecast faster at a higher price than Near Mint", () => {
    const nearMint = calculateDemandCurve({
      sales,
      siblingMarketPrices: new Map(),
      targetCondition: "Near Mint",
      asOf,
      supply,
      policy,
      sourceWeights,
      ...sampleGuard,
      minimumSample: 3,
      trimPercentile: 0,
    })!;
    const damaged = calculateDemandCurve({
      sales,
      siblingMarketPrices: new Map(),
      targetCondition: "Damaged",
      asOf,
      supply,
      policy,
      sourceWeights,
      ...sampleGuard,
      minimumSample: 3,
      trimPercentile: 0,
    })!;
    for (const [index, point] of damaged.points.entries()) {
      expect(Number(point.priceAmount)).toBeLessThanOrEqual(Number(nearMint.points[index]!.priceAmount));
      expect(point.medianSellDays).toBeGreaterThanOrEqual((nearMint.points[index]!.medianSellDays ?? 0) - 1e-8);
    }
  });

  it("an unscoped or truncated capture never claims a seller count", () => {
    for (const status of ["unavailable", "truncated"] as const) {
      const result = calculateDemandCurve({
        sales,
        siblingMarketPrices: new Map(),
        targetCondition: "Near Mint",
        asOf,
        supply: { ...supply, status },
        policy,
        sourceWeights,
        ...sampleGuard,
        minimumSample: 3,
        trimPercentile: 0,
      });
      expect(
        result?.points.every((point) => point.competingSellerCount === null && point.supplyStatus === status),
      ).toBe(true);
    }
  });

  it("caps repeated platform-buyer weight and refuses an ineffective one-print sample", () => {
    const evidence: CurveSale[] = [
      { ...sales[0]!, price: 100, source: "platform-verified-trade", participantId: "buyer-one" },
      { ...sales[0]!, price: 100, source: "platform-verified-trade", participantId: "buyer-one" },
      { ...sales[0]!, price: 10, source: "external-comp" },
    ];
    const base = {
      sales: evidence,
      siblingMarketPrices: new Map<string, number>(),
      targetCondition: "Near Mint",
      asOf,
      supply,
      policy,
      sourceWeights: { platformVerifiedTrade: 1, platformTrade: 1, externalComp: 1 },
      minimumSample: 1,
      minimumEffectiveSampleSize: 1,
      trimPercentile: 0,
    };
    const capped = calculateDemandCurve({ ...base, maximumParticipantWeightShare: 0.3 });
    const uncapped = calculateDemandCurve({ ...base, maximumParticipantWeightShare: 1 });
    expect(Number(capped!.points.find((point) => point.percentile === 50)!.priceAmount)).toBe(10);
    expect(Number(uncapped!.points.find((point) => point.percentile === 50)!.priceAmount)).toBe(55);
    expect(
      calculateDemandCurve({
        ...base,
        sales: evidence.slice(0, 1),
        minimumEffectiveSampleSize: 2,
        maximumParticipantWeightShare: 1,
      }),
    ).toBeNull();
  });
});
