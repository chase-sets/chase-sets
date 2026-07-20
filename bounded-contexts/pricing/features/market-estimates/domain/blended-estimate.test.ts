import { describe, expect, it } from "vitest";
import {
  calculateBlendedMarketValueEstimate,
  type BlendedEstimateParams,
  type ComparableSale,
} from "./blended-estimate";

const NOW = "2026-07-16T12:00:00.000Z";

const params: BlendedEstimateParams = {
  now: NOW,
  decayHalfLifeDays: 7,
  sourceWeights: { platformVerifiedTrade: 1, platformTrade: 0.7, externalComp: 0.4 },
  estimatePercentile: 50,
  bandLowPercentile: 20,
  bandHighPercentile: 80,
  minimumComparableSales: 3,
  minimumEffectiveSampleSize: 2,
  outlierPriceRatio: 10,
  maximumParticipantWeightShare: 0.3,
  confidenceSampleSizes: { medium: 8, high: 20 },
};

let nextParticipant = 0;

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
}

function trade(
  priceAmount: number,
  ageDays: number,
  verified = false,
  participant?: Readonly<{ buyerAccountId: string; sellerAccountId: string }>,
): ComparableSale {
  nextParticipant += 1;
  return {
    priceAmount,
    observedAt: daysAgo(ageDays),
    source: verified ? "platform-verified-trade" : "platform-trade",
    buyerAccountId: participant?.buyerAccountId ?? `buyer_${nextParticipant}`,
    sellerAccountId: participant?.sellerAccountId ?? `seller_${nextParticipant}`,
  };
}

function comp(priceAmount: number, ageDays: number): ComparableSale {
  return { priceAmount, observedAt: daysAgo(ageDays), source: "external-comp" };
}

describe("calculateBlendedMarketValueEstimate", () => {
  it("estimates from platform trades only (comp inputs are optional from day one)", () => {
    const result = calculateBlendedMarketValueEstimate(
      [trade(10, 1, true), trade(12, 2), trade(14, 3, true), trade(16, 4)],
      params,
    );

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(Number(result.amount)).toBeGreaterThanOrEqual(10);
    expect(Number(result.amount)).toBeLessThanOrEqual(16);
    expect(result.inputCounts).toEqual({
      platformVerifiedTradeCount: 2,
      platformTradeCount: 2,
      externalCompCount: 0,
    });
  });

  it("estimates from external comps only", () => {
    const result = calculateBlendedMarketValueEstimate([comp(20, 0), comp(22, 1), comp(24, 2)], params);

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(Number(result.amount)).toBeGreaterThanOrEqual(20);
    expect(Number(result.amount)).toBeLessThanOrEqual(24);
    expect(result.inputCounts.externalCompCount).toBe(3);
  });

  it("blends mixed inputs with verified platform trades outweighing external comps", () => {
    // Same ages, so only source weight separates them: two verified trades at
    // 10.00 carry weight 2.0 against two external comps at 30.00 carrying 0.8.
    // The weighted median must land in the verified cluster's half.
    const result = calculateBlendedMarketValueEstimate(
      [trade(10, 0, true), trade(10, 0, true), comp(30, 0), comp(30, 0)],
      params,
    );

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(Number(result.amount)).toBeLessThan(20);
  });

  it("weights recent sales above old ones through exponential time decay", () => {
    // One half-life-old sale at 10.00 (weight 0.5) vs a fresh sale at 20.00
    // (weight 1.0), both unverified plus a third input to clear the gate:
    // the weighted median must sit closer to the fresh price than a
    // decay-free median would.
    const withDecay = calculateBlendedMarketValueEstimate([trade(10, 14), trade(20, 0), trade(20, 0)], params);
    const withoutDecay = calculateBlendedMarketValueEstimate([trade(10, 0), trade(20, 0), trade(20, 0)], params);

    expect(withDecay.status).toBe("estimated");
    expect(withoutDecay.status).toBe("estimated");
    if (withDecay.status !== "estimated" || withoutDecay.status !== "estimated") return;
    expect(Number(withDecay.amount)).toBeGreaterThanOrEqual(Number(withoutDecay.amount));
    expect(Number(withDecay.amount)).toBeGreaterThan(15);
  });

  it("refuses to estimate below the minimum-input gate -- never a garbage number", () => {
    const result = calculateBlendedMarketValueEstimate([trade(10, 1), trade(12, 2)], params);

    expect(result).toEqual({
      status: "no-estimate",
      reason: "below-minimum-inputs",
      inputCounts: { platformVerifiedTradeCount: 0, platformTradeCount: 2, externalCompCount: 0 },
    });
  });

  it("refuses to estimate with zero usable inputs (non-positive prices are dropped)", () => {
    const result = calculateBlendedMarketValueEstimate([trade(0, 1), trade(-5, 2)], params);

    expect(result.status).toBe("no-estimate");
    if (result.status !== "no-estimate") return;
    expect(result.reason).toBe("no-usable-inputs");
  });

  it("produces a confidence band that always contains the estimate", () => {
    const sales = [trade(8, 1, true), trade(10, 2), trade(12, 3), comp(15, 1), comp(18, 4)];
    const result = calculateBlendedMarketValueEstimate(sales, params);

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(Number(result.bandLowAmount)).toBeLessThanOrEqual(Number(result.amount));
    expect(Number(result.bandHighAmount)).toBeGreaterThanOrEqual(Number(result.amount));
    expect(Number(result.bandLowAmount)).toBeLessThan(Number(result.bandHighAmount));
  });

  it("grades confidence by independent evidence count", () => {
    const low = calculateBlendedMarketValueEstimate([trade(10, 1), trade(11, 1), trade(12, 1)], params);
    const medium = calculateBlendedMarketValueEstimate(
      Array.from({ length: 8 }, (_, index) => trade(10 + index, 1)),
      params,
    );
    const high = calculateBlendedMarketValueEstimate(
      Array.from({ length: 20 }, (_, index) => trade(10 + (index % 5), 1, index % 2 === 0)),
      params,
    );

    expect(low.status === "estimated" && low.confidence).toBe("low");
    expect(medium.status === "estimated" && medium.confidence).toBe("medium");
    expect(high.status === "estimated" && high.confidence).toBe("high");
  });

  describe("participant hygiene", () => {
    it("collapses repeat buyer-to-seller prints to the latest Comparable Sale", () => {
      const repeatPair = { buyerAccountId: "buyer_repeat", sellerAccountId: "seller_repeat" };
      const otherOne = { buyerAccountId: "buyer_2", sellerAccountId: "seller_2" };
      const otherTwo = { buyerAccountId: "buyer_3", sellerAccountId: "seller_3" };
      const repeated = calculateBlendedMarketValueEstimate(
        [
          trade(100, 4, false, repeatPair),
          trade(90, 3, false, repeatPair),
          trade(30, 1, false, repeatPair),
          trade(10, 1, false, otherOne),
          trade(20, 1, false, otherTwo),
        ],
        params,
      );
      const oneLatestPrint = calculateBlendedMarketValueEstimate(
        [trade(30, 1, false, repeatPair), trade(10, 1, false, otherOne), trade(20, 1, false, otherTwo)],
        params,
      );

      expect(repeated).toEqual(oneLatestPrint);
      expect(repeated.status === "estimated" && repeated.inputCounts.platformTradeCount).toBe(3);
    });

    it("requires distinct Market Participants rather than three prints from one buyer", () => {
      const oneParticipant = calculateBlendedMarketValueEstimate(
        [
          trade(10, 3, false, { buyerAccountId: "buyer_1", sellerAccountId: "seller_1" }),
          trade(11, 2, false, { buyerAccountId: "buyer_1", sellerAccountId: "seller_2" }),
          trade(12, 1, false, { buyerAccountId: "buyer_1", sellerAccountId: "seller_3" }),
        ],
        params,
      );
      const threeParticipants = calculateBlendedMarketValueEstimate([trade(10, 3), trade(11, 2), trade(12, 1)], params);

      expect(oneParticipant).toEqual({
        status: "no-estimate",
        reason: "below-minimum-inputs",
        inputCounts: { platformVerifiedTradeCount: 0, platformTradeCount: 3, externalCompCount: 0 },
      });
      expect(threeParticipants.status).toBe("estimated");
    });

    it("caps one buyer's aggregate weight while preserving legitimate trades with different sellers", () => {
      const dominantBuyerTrades = Array.from({ length: 4 }, (_, index) =>
        trade(100, 0, false, {
          buyerAccountId: "buyer_dominant",
          sellerAccountId: `seller_dominant_${index}`,
        }),
      );
      const sales = [...dominantBuyerTrades, trade(10, 0), trade(10, 0)];
      const capped = calculateBlendedMarketValueEstimate(sales, params);
      const uncapped = calculateBlendedMarketValueEstimate(sales, {
        ...params,
        maximumParticipantWeightShare: 1,
      });

      expect(capped.status === "estimated" && capped.amount).toBe("10.00");
      expect(uncapped.status === "estimated" && Number(uncapped.amount)).toBeGreaterThan(50);
    });

    it("grades confidence by distinct Market Participants, not a buyer's print count", () => {
      const repeatedBuyer = Array.from({ length: 20 }, (_, index) =>
        trade(10 + (index % 5), 1, false, {
          buyerAccountId: "buyer_repeat",
          sellerAccountId: `seller_repeat_${index}`,
        }),
      );
      const low = calculateBlendedMarketValueEstimate([...repeatedBuyer, trade(10, 1), trade(11, 1)], params);
      const medium = calculateBlendedMarketValueEstimate(
        Array.from({ length: 8 }, (_, index) => trade(10 + index, 1)),
        params,
      );
      const high = calculateBlendedMarketValueEstimate(
        Array.from({ length: 20 }, (_, index) => trade(10 + (index % 5), 1)),
        params,
      );

      expect(low.status === "estimated" && low.confidence).toBe("low");
      expect(medium.status === "estimated" && medium.confidence).toBe("medium");
      expect(high.status === "estimated" && high.confidence).toBe("high");
    });
  });

  it("never publishes a garbage number: a fresh extreme comp next to aged consistent trades fails the effective-sample-size gate (review probe)", () => {
    // The review-gate probe verbatim: two $10/$11 verified trades aged 89
    // days + one fresh $9,999,999,999 external comp. Decay leaves the trades
    // ~1.5e-4 weight each against the comp's 0.4 -- effectively ONE input,
    // and one input never publishes (previously published ~$5.0B).
    const result = calculateBlendedMarketValueEstimate(
      [trade(10, 89, true), trade(11, 89, true), comp(9_999_999_999, 0)],
      params,
    );

    expect(result).toEqual({
      status: "no-estimate",
      reason: "below-minimum-effective-inputs",
      inputCounts: { platformVerifiedTradeCount: 2, platformTradeCount: 0, externalCompCount: 1 },
    });
  });

  it("winsorizes an extreme high comp against the trade core when effective inputs DO clear the gate", () => {
    // Enough fresh trades to clear both gates -- the extreme comp still
    // counts as an observation, but its magnitude is clamped to
    // core * outlierPriceRatio, so neither the estimate nor the band can
    // leave the core's order of magnitude.
    const result = calculateBlendedMarketValueEstimate(
      [trade(10, 0), trade(10, 0), trade(10, 0), trade(10, 0), trade(10, 0), comp(9_999_999_999, 0)],
      params,
    );

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(result.amount).toBe("10.00");
    expect(Number(result.bandHighAmount)).toBeLessThanOrEqual(100); // core 10 x ratio 10
  });

  it("winsorizes an extreme low comp symmetrically (band floor at core / ratio)", () => {
    const result = calculateBlendedMarketValueEstimate(
      [trade(10, 0), trade(10, 0), trade(10, 0), trade(10, 0), trade(10, 0), comp(0.01, 0)],
      params,
    );

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(result.amount).toBe("10.00");
    expect(Number(result.bandLowAmount)).toBeGreaterThanOrEqual(1); // core 10 / ratio 10
  });

  it("winsorizes a comps-only extreme mix against the overall weighted median (no trade core to anchor on)", () => {
    const result = calculateBlendedMarketValueEstimate([comp(20, 0), comp(22, 0), comp(9_999_999_999, 0)], params);

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(Number(result.amount)).toBeLessThan(30);
    expect(Number(result.bandHighAmount)).toBeLessThanOrEqual(220); // median ~21 x ratio 10
  });

  it("is skew-invariant: a comparable observed 3h in the future changes nothing across same-day recomputes (review probe)", () => {
    // +3h writer clock skew: the un-clamped decay gives the future comp
    // weight > 1, so advancing `now` rescales EVERY weight uniformly and the
    // published values are identical -- the same-day dedupe's contract.
    const sales = [trade(10, 1, true), trade(11, 2), comp(12, -3 / 24)];
    const atNoon = calculateBlendedMarketValueEstimate(sales, params);
    const sixHoursLater = calculateBlendedMarketValueEstimate(sales, {
      ...params,
      now: new Date(Date.parse(NOW) + 6 * 60 * 60 * 1000).toISOString(),
    });

    expect(atNoon.status).toBe("estimated");
    expect(atNoon).toEqual(sixHoursLater);
  });

  it("is deterministic: same inputs and same now always produce the same estimate", () => {
    const sales = [trade(9.99, 1, true), trade(12.5, 3), comp(15.25, 2), trade(11, 6), comp(13.4, 8)];
    const first = calculateBlendedMarketValueEstimate(sales, params);
    const second = calculateBlendedMarketValueEstimate([...sales].reverse(), params);

    expect(first).toEqual(second);
  });

  it("interpolates the weighted percentile between straddling prices (ported cumulative-weight behavior)", () => {
    // Three equal-weight, equal-age sales at 10 / 20 / 30: cumulative weights
    // 1, 2, 3 of total 3, p50 target weight 1.5 -- the ported algorithm
    // interpolates halfway between the first two prices, exactly as
    // getTimeDecayedPercentileWeightedSuggestedPrice does.
    const result = calculateBlendedMarketValueEstimate([trade(10, 0), trade(20, 0), trade(30, 0)], params);

    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(Number(result.amount)).toBeCloseTo(15, 5);
  });
});
