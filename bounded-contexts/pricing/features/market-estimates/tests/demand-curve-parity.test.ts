import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateDemandCurve } from "../domain/demand-curve/curve";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE as policy } from "../domain/demand-curve-policy";
import { effectiveSaleAmountExact } from "../../price-signals/domain/effective-sale-price";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../../price-signals/domain/provider-observation-policy";
import { generateSyntheticProviderObservationFixture } from "../../price-signals/tests/fixtures/provider-observations/generate-fixture";

const expected = JSON.parse(
  readFileSync(new URL("./fixtures/app-recorded-ninety-day-oracle.json", import.meta.url), "utf8"),
) as {
  sourceCommit: string;
  ladderMethod: string;
  points: readonly {
    percentile: number;
    price: number;
    buyerIntervalDays: number;
    sellers: number;
    medianSellDays: number;
    qualifyingSaleCount: number;
  }[];
};

describe("the app-recorded post-hygiene ninety-day fixture", () => {
  it("matches price, buyer arrival, pooled seller count, and median sell days at all 19 standard percentiles", () => {
    const { capture } = generateSyntheticProviderObservationFixture();
    expect(expected.sourceCommit).toBe("bdeffa0190be035084abccb464716aaaa2541a59");
    const sales = capture.sales.map((sale) => ({
      price: effectiveSaleAmountExact(
        { quantity: sale.quantity, unitPrice: Number(sale.unitPrice), orderShipping: Number(sale.orderShipping) },
        Number(PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.freeShippingThreshold),
      ),
      soldAt: sale.soldAt,
      condition: sale.providerCondition,
      variant: sale.providerVariant,
      language: sale.providerLanguage,
      source: "external-comp" as const,
      coverage: "complete",
    }));
    const result = calculateDemandCurve({
      sales,
      siblingMarketPrices: new Map(),
      targetCondition: "Near Mint",
      asOf: capture.header.captureStartedAt,
      policy,
      supply: {
        status: "observed",
        ownSellerExclusionApplied: false,
        asks: capture.askDepth.map((ask) => ({
          condition: ask.providerCondition,
          deliveredAmount: Number(ask.deliveredAmount),
          sellerOrdinal: ask.anonymousCaptureSellerOrdinal,
        })),
      },
      sourceWeights: { platformVerifiedTrade: 1, platformTrade: 0.7, externalComp: 0.4 },
      minimumEffectiveSampleSize: 2,
      maximumParticipantWeightShare: 0.3,
      minimumSample: 3,
      trimPercentile: 5,
    });
    expect(result?.ladder.method).toBe(expected.ladderMethod);
    expect(result?.points).toHaveLength(19);
    for (const [index, expectedPoint] of expected.points.entries()) {
      const actual = result!.points[index]!;
      expect(actual.percentile).toBe(expectedPoint.percentile);
      expect(
        Math.abs(Number(actual.priceAmount) - expectedPoint.price),
        `P${expectedPoint.percentile}: ${actual.priceAmount} versus ${expectedPoint.price}`,
      ).toBeLessThanOrEqual(0.01);
      expect(relativeError(actual.buyerArrivalIntervalDays, expectedPoint.buyerIntervalDays)).toBeLessThanOrEqual(0.01);
      expect(actual.competingSellerCount).toBe(expectedPoint.sellers);
      expect(relativeError(actual.medianSellDays, expectedPoint.medianSellDays)).toBeLessThanOrEqual(0.01);
      expect(actual.qualifyingSaleCount).toBe(expectedPoint.qualifyingSaleCount);
    }
  });
});

function relativeError(actual: number | null, expected: number): number {
  return actual === null ? Infinity : Math.abs(actual - expected) / Math.max(expected, 1e-9);
}
