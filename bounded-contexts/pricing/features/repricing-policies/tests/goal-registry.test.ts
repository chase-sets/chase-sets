import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import { fixedPercentileGoal } from "../domain/goals/fixed-percentile";
import { profitPerDayGoal } from "../domain/goals/profit-per-day";
import {
  createPricingGoalRegistry,
  validateParameters,
  type GoalCurve,
  type GoalDecision,
  type GoalSolveInput,
  type PricingGoalDefinition,
} from "../domain/goals/registry";
import { targetHorizonGoal } from "../domain/goals/target-horizon";
import { resolvedGoalEconomics, unavailableGoalEconomics, type GoalFeeTerms } from "./fixtures/goal-economics";

const parityCurves = (
  JSON.parse(readFileSync(new URL("./fixtures/goal-parity-curve.json", import.meta.url), "utf8")) as {
    curves: Readonly<Record<string, GoalCurve>>;
  }
).curves;
const observed = parityCurves.observed!;
const truncated = parityCurves["truncated-supply"]!;

const typicalTerms: GoalFeeTerms = {
  platformFeeRelativeBps: 1_075,
  platformFeeFixedPerUnitAmount: "0.30",
  platformFeeCapPerUnitAmount: null,
  sellerHandlingRelativeBps: 250,
  sellerHandlingFixedPerUnitAmount: "0.20",
  sellerHandlingCapPerUnitAmount: null,
};
const fixedSixDollarTerms: GoalFeeTerms = {
  ...typicalTerms,
  platformFeeRelativeBps: 0,
  platformFeeFixedPerUnitAmount: "6.00",
  sellerHandlingRelativeBps: 0,
  sellerHandlingFixedPerUnitAmount: "0.00",
};
const goals = [fixedPercentileGoal, targetHorizonGoal, profitPerDayGoal] as const;
const curveOnlyGoals = [fixedPercentileGoal, targetHorizonGoal] as const;

/** One observed point with no competing seller, so Store Win Share is 1 and the median is ln 2 x interval. */
function point(percentile: number, priceAmount: string, medianSellDays: number | null): CurvePoint {
  return {
    percentile,
    priceAmount,
    buyerArrivalIntervalDays: medianSellDays === null ? null : medianSellDays / Math.LN2,
    competingSellerCount: 0,
    storeWinShare: 1,
    medianSellDays,
    qualifyingSaleCount: 10,
    historyCapped: false,
    hopeless: false,
    supplyStatus: "observed",
  };
}

function curve(points: readonly CurvePoint[], currencyCode = "USD"): GoalCurve {
  return { currencyCode, version: 1, points };
}

function solve(goal: PricingGoalDefinition, input: Partial<GoalSolveInput> = {}) {
  return goal.solve({ curve: observed, economics: null, parameters: {}, ...input });
}

function decision(goal: PricingGoalDefinition, input: Partial<GoalSolveInput> = {}): GoalDecision {
  const result = solve(goal, input);
  if (result.kind !== "decision") throw new Error(`${goal.id} returned ${result.reason}.`);
  return result;
}

describe("AC2: Economics availability and currency", () => {
  it("returns economics-unavailable with no price for unavailable or absent Economics", () => {
    expect(solve(profitPerDayGoal, { economics: unavailableGoalEconomics() })).toEqual({
      kind: "unavailable",
      reason: "economics-unavailable",
    });
    expect(solve(profitPerDayGoal, { economics: null })).toEqual({
      kind: "unavailable",
      reason: "economics-unavailable",
    });
  });

  it("solves usd Economics on a USD curve and rejects eur Economics as economics-currency-mismatch", () => {
    const usd = resolvedGoalEconomics(typicalTerms, 0.005);
    expect(usd.currency).toBe("usd");
    expect(observed.currencyCode).toBe("USD");
    expect(solve(profitPerDayGoal, { economics: usd }).kind).toBe("decision");
    expect(
      solve(profitPerDayGoal, {
        economics: resolvedGoalEconomics(typicalTerms, 0.005, "USD"),
        curve: curve(observed.points, "usd"),
      }).kind,
    ).toBe("decision");
    expect(solve(profitPerDayGoal, { economics: resolvedGoalEconomics(typicalTerms, 0.005, "eur") })).toEqual({
      kind: "unavailable",
      reason: "economics-currency-mismatch",
    });
  });

  it("checks availability before currency", () => {
    expect(solve(profitPerDayGoal, { economics: unavailableGoalEconomics("eur") })).toEqual({
      kind: "unavailable",
      reason: "economics-unavailable",
    });
  });

  it("lets the curve-only goals ignore Economics entirely", () => {
    for (const goal of curveOnlyGoals) {
      const withoutEconomics = decision(goal);
      for (const economics of [
        unavailableGoalEconomics(),
        resolvedGoalEconomics(typicalTerms, 0.02, "eur"),
        resolvedGoalEconomics(fixedSixDollarTerms, 0.02),
      ]) {
        expect(decision(goal, { economics }), goal.id).toEqual(withoutEconomics);
      }
      expect(withoutEconomics.unprofitable).toBe(false);
      expect(withoutEconomics.rationale).toEqual({
        parameters: goal.id === "fixed-percentile" ? { percentile: 65 } : { horizonDays: 30 },
        dailyReturnHurdle: null,
        netProceeds: null,
      });
    }
  });
});

describe("AC3: parameter schema and registration", () => {
  it("registers the three version 1 goals exactly as the registration table", () => {
    const registry = createPricingGoalRegistry(goals);
    expect(
      registry
        .definitions()
        .map(({ id, version, lifecycle, parameterSchema, requiredCurveFeatures, requiresEconomics }) => ({
          id,
          version,
          lifecycle,
          parameterSchema,
          requiredCurveFeatures,
          requiresEconomics,
        })),
    ).toEqual([
      {
        id: "fixed-percentile",
        version: 1,
        lifecycle: "selectable",
        parameterSchema: { percentile: { default: 65, minimum: 1, maximum: 99 } },
        requiredCurveFeatures: [],
        requiresEconomics: false,
      },
      {
        id: "profit-per-day",
        version: 1,
        lifecycle: "selectable",
        parameterSchema: {},
        requiredCurveFeatures: ["buyerArrivalIntervalDays", "storeWinShare"],
        requiresEconomics: true,
      },
      {
        id: "target-horizon",
        version: 1,
        lifecycle: "selectable",
        parameterSchema: { horizonDays: { default: 30, minimum: 1, maximum: 365 } },
        requiredCurveFeatures: ["buyerArrivalIntervalDays", "storeWinShare"],
        requiresEconomics: false,
      },
    ]);
    expect(registry.resolve("target-horizon", 1)).toBe(targetHorizonGoal);
    expect(registry.resolve("target-horizon", 2)).toBeNull();
    expect(registry.resolve("cash-target", 1)).toBeNull();
  });

  it("fills the table defaults only for missing keys and accepts both inclusive bounds", () => {
    expect(validateParameters(fixedPercentileGoal.parameterSchema, {})).toEqual({
      kind: "valid",
      parameters: { percentile: 65 },
    });
    expect(validateParameters(targetHorizonGoal.parameterSchema, {})).toEqual({
      kind: "valid",
      parameters: { horizonDays: 30 },
    });
    expect(validateParameters(profitPerDayGoal.parameterSchema, {})).toEqual({ kind: "valid", parameters: {} });
    for (const percentile of [1, 50, 99]) {
      expect(validateParameters(fixedPercentileGoal.parameterSchema, { percentile })).toEqual({
        kind: "valid",
        parameters: { percentile },
      });
    }
    for (const horizonDays of [1, 365]) {
      expect(validateParameters(targetHorizonGoal.parameterSchema, { horizonDays })).toEqual({
        kind: "valid",
        parameters: { horizonDays },
      });
    }
  });

  it("solves the defaults when no parameter is supplied and an explicit value when one is", () => {
    expect(decision(fixedPercentileGoal)).toEqual(decision(fixedPercentileGoal, { parameters: { percentile: 65 } }));
    expect(decision(fixedPercentileGoal).selectedPriceAmount).toBe("8.75");
    expect(decision(fixedPercentileGoal, { parameters: { percentile: 50 } }).selectedPriceAmount).toBe("6.95");
    expect(decision(targetHorizonGoal)).toEqual(decision(targetHorizonGoal, { parameters: { horizonDays: 30 } }));
    expect(decision(targetHorizonGoal, { parameters: { horizonDays: 7 } }).selectedPriceAmount).not.toBe(
      decision(targetHorizonGoal).selectedPriceAmount,
    );
  });

  it("prices a percentile beyond the curve's end points at that end point, and a horizon past the slowest point there", () => {
    expect(decision(fixedPercentileGoal, { parameters: { percentile: 1 } })).toMatchObject({
      selectedPriceAmount: "3.95",
      equivalentPercentile: 5,
    });
    expect(decision(fixedPercentileGoal, { parameters: { percentile: 99 } })).toMatchObject({
      selectedPriceAmount: "19.95",
      equivalentPercentile: 95,
    });
    const shortCurve = curve(observed.points.slice(0, 18));
    expect(shortCurve.points.at(-1)!.medianSellDays!).toBeLessThan(365);
    expect(decision(targetHorizonGoal, { curve: shortCurve, parameters: { horizonDays: 365 } })).toMatchObject({
      selectedPriceAmount: "15.99",
      equivalentPercentile: 90,
    });
    // The fixture's slowest point is hopeless (beyond 365 days), so the upper bound stops short of it.
    const atBound = Number(decision(targetHorizonGoal, { parameters: { horizonDays: 365 } }).selectedPriceAmount);
    expect(atBound).toBeGreaterThan(15.99);
    expect(atBound).toBeLessThan(19.95);
  });

  it("rejects unknown keys and any value that is not a number within bounds, with stable reason codes", () => {
    expect(validateParameters(fixedPercentileGoal.parameterSchema, { percentile: 50, horizonDays: 30 })).toEqual({
      kind: "rejected",
      rejections: [{ reason: "goal-parameter-unknown", parameter: "horizonDays" }],
    });
    expect(validateParameters(profitPerDayGoal.parameterSchema, { dailyReturnHurdle: 0.01 })).toEqual({
      kind: "rejected",
      rejections: [{ reason: "goal-parameter-unknown", parameter: "dailyReturnHurdle" }],
    });
    for (const inherited of ["toString", "constructor", "__proto__"]) {
      expect(validateParameters(fixedPercentileGoal.parameterSchema, JSON.parse(`{"${inherited}": 50}`))).toEqual({
        kind: "rejected",
        rejections: [{ reason: "goal-parameter-unknown", parameter: inherited }],
      });
    }
    for (const percentile of [
      0,
      0.999,
      99.001,
      100,
      -65,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "65",
      null,
      true,
      undefined,
    ]) {
      expect(validateParameters(fixedPercentileGoal.parameterSchema, { percentile }), String(percentile)).toEqual({
        kind: "rejected",
        rejections: [{ reason: "goal-parameter-out-of-bounds", parameter: "percentile" }],
      });
    }
    for (const horizonDays of [0, 0.5, 365.5, 366]) {
      expect(validateParameters(targetHorizonGoal.parameterSchema, { horizonDays })).toEqual({
        kind: "rejected",
        rejections: [{ reason: "goal-parameter-out-of-bounds", parameter: "horizonDays" }],
      });
    }
    expect(validateParameters(fixedPercentileGoal.parameterSchema, { zeta: 1, percentile: 150, alpha: 2 })).toEqual({
      kind: "rejected",
      rejections: [
        { reason: "goal-parameter-unknown", parameter: "alpha" },
        { reason: "goal-parameter-unknown", parameter: "zeta" },
        { reason: "goal-parameter-out-of-bounds", parameter: "percentile" },
      ],
    });
  });

  it("refuses to solve parameters that were never validated", () => {
    expect(() => solve(fixedPercentileGoal, { parameters: { percentile: 150 } })).toThrow(
      "Pricing Goal fixed-percentile@1 parameters were not validated: goal-parameter-out-of-bounds percentile.",
    );
    expect(() =>
      solve(profitPerDayGoal, {
        parameters: { dailyReturnHurdle: 0.01 },
        economics: resolvedGoalEconomics(typicalTerms, 0.005),
      }),
    ).toThrow("goal-parameter-unknown dailyReturnHurdle");
  });

  it("rejects a duplicate (id, version), an id outside the pattern, a non-positive-integer version and an unbounded default", () => {
    const registry = createPricingGoalRegistry(goals);
    expect(() => registry.registerPricingGoal(fixedPercentileGoal)).toThrow(
      "Pricing Goal fixed-percentile@1 is already registered.",
    );
    registry.registerPricingGoal({ ...fixedPercentileGoal, version: 2 });
    expect(registry.resolve("fixed-percentile", 2)?.version).toBe(2);
    expect(registry.resolve("fixed-percentile", 1)).toBe(fixedPercentileGoal);
    for (const id of ["Fixed-Percentile", "1-percentile", "fixed_percentile", "fixed percentile", "", "-fixed"]) {
      expect(() => createPricingGoalRegistry([{ ...fixedPercentileGoal, id }]), id).toThrow(/must match \^\[a-z\]/);
    }
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => createPricingGoalRegistry([{ ...fixedPercentileGoal, version }]), String(version)).toThrow(
        "Pricing Goal fixed-percentile version must be a positive integer.",
      );
    }
    for (const bounds of [
      { default: 0, minimum: 1, maximum: 99 },
      { default: 65, minimum: 70, maximum: 99 },
      { default: 65, minimum: Number.NEGATIVE_INFINITY, maximum: 99 },
    ]) {
      expect(() =>
        createPricingGoalRegistry([{ ...fixedPercentileGoal, parameterSchema: { percentile: bounds } }]),
      ).toThrow("Pricing Goal fixed-percentile parameter percentile needs a default within finite inclusive bounds.");
    }
  });
});

describe("AC4: unavailable curves, capped terms, least loss and explanations", () => {
  it("names the first declared feature that every point lacks", () => {
    const economics = resolvedGoalEconomics(typicalTerms, 0.005);
    const withoutInterval = curve(
      observed.points.map((entry) => ({ ...entry, buyerArrivalIntervalDays: null, medianSellDays: null })),
    );
    for (const goal of [targetHorizonGoal, profitPerDayGoal]) {
      expect(solve(goal, { curve: truncated, economics })).toEqual({
        kind: "unavailable",
        reason: "curve-feature-missing:storeWinShare",
      });
      expect(solve(goal, { curve: withoutInterval, economics })).toEqual({
        kind: "unavailable",
        reason: "curve-feature-missing:buyerArrivalIntervalDays",
      });
      expect(
        solve(goal, {
          curve: curve(truncated.points.map((entry) => ({ ...entry, buyerArrivalIntervalDays: null }))),
          economics,
        }),
      ).toEqual({
        kind: "unavailable",
        reason: "curve-feature-missing:buyerArrivalIntervalDays",
      });
    }
  });

  it("solves when only some points lack a feature, and fixed-percentile needs none", () => {
    const economics = resolvedGoalEconomics(typicalTerms, 0.005);
    const partlyMissing = curve(
      observed.points.map((entry, index) =>
        index % 2 === 0 ? { ...entry, buyerArrivalIntervalDays: null, medianSellDays: null } : entry,
      ),
    );
    expect(solve(targetHorizonGoal, { curve: partlyMissing }).kind).toBe("decision");
    expect(solve(profitPerDayGoal, { curve: partlyMissing, economics }).kind).toBe("decision");
    expect(decision(fixedPercentileGoal, { curve: truncated }).forecast).toEqual({
      medianSellDays: null,
      status: "unavailable",
    });
  });

  it("returns curve-feature-missing:medianSellDays when no single point carries both sell-time inputs", () => {
    const split = curve(
      [
        { ...point(40, "5.00", null), buyerArrivalIntervalDays: 3 },
        { ...point(60, "6.00", null), buyerArrivalIntervalDays: null },
      ].map((entry, index) => ({ ...entry, storeWinShare: index === 0 ? null : 1 })),
    );
    expect(solve(targetHorizonGoal, { curve: split })).toEqual({
      kind: "unavailable",
      reason: "curve-feature-missing:medianSellDays",
    });
  });

  it("returns curve-empty before any feature or Economics reason", () => {
    for (const goal of goals) {
      expect(solve(goal, { curve: curve([]) }), goal.id).toEqual({ kind: "unavailable", reason: "curve-empty" });
      expect(solve(goal, { curve: curve([point(50, "0.00", 3)]) }), goal.id).toEqual({
        kind: "unavailable",
        reason: "curve-empty",
      });
    }
  });

  it("matches an independent brute-force oracle with capped fee terms, where the cap moves the decision", () => {
    // Two sharp peaks: each steep rise ends where a nearly flat stretch begins. With every Store Win
    // Share equal, the median is linear in the interval, so price is piecewise linear in sell time.
    const path = [
      [20, "10.00", 1],
      [50, "12.00", 2],
      [60, "12.02", 20],
      [90, "20.00", 24],
      [95, "20.02", 100],
    ] as const;
    const peaks = curve(
      path.map(([percentile, priceAmount, medianSellDays]) => point(percentile, priceAmount, medianSellDays)),
    );
    const capped: GoalFeeTerms = {
      platformFeeRelativeBps: 5_000,
      platformFeeFixedPerUnitAmount: "0.30",
      platformFeeCapPerUnitAmount: "5.70",
      sellerHandlingRelativeBps: 0,
      sellerHandlingFixedPerUnitAmount: "0.00",
      sellerHandlingCapPerUnitAmount: null,
    };
    const uncapped: GoalFeeTerms = { ...capped, platformFeeCapPerUnitAmount: null };
    const hurdle = 0.03;
    const independentNet = (price: number, terms: GoalFeeTerms) => {
      const term = (bps: number, fixed: string, cap: string | null) =>
        (cap === null ? (price * bps) / 10_000 : Math.min((price * bps) / 10_000, Number(cap))) + Number(fixed);
      return (
        price -
        term(terms.platformFeeRelativeBps, terms.platformFeeFixedPerUnitAmount, terms.platformFeeCapPerUnitAmount) -
        term(
          terms.sellerHandlingRelativeBps,
          terms.sellerHandlingFixedPerUnitAmount,
          terms.sellerHandlingCapPerUnitAmount,
        )
      );
    };
    const bruteForcePrice = (terms: GoalFeeTerms) => {
      let best = { price: Number.NaN, value: Number.NEGATIVE_INFINITY };
      for (let step = 0; step <= 198_000; step += 1) {
        const sellDays = 1 + step / 2_000;
        const upper = path.findIndex(([, , medianSellDays]) => medianSellDays >= sellDays);
        const [, lowerPrice, lowerDays] = path[Math.max(0, upper - 1)]!;
        const [, upperPrice, upperDays] = path[upper]!;
        const ratio = upperDays === lowerDays ? 0 : (sellDays - lowerDays) / (upperDays - lowerDays);
        const price = Math.round((Number(lowerPrice) + (Number(upperPrice) - Number(lowerPrice)) * ratio) * 100) / 100;
        const net = independentNet(price, terms);
        const value = net > 0 ? net * Math.exp(-hurdle * sellDays) : net;
        if (value > best.value) best = { price, value };
      }
      return best.price.toFixed(2);
    };

    const cappedDecision = decision(profitPerDayGoal, {
      curve: peaks,
      economics: resolvedGoalEconomics(capped, hurdle),
    });
    expect(bruteForcePrice(capped)).toBe("20.00");
    expect(cappedDecision.selectedPriceAmount).toBe(bruteForcePrice(capped));
    expect(cappedDecision.rationale.netProceeds).toBe(independentNet(20, capped).toFixed(2));
    expect(cappedDecision.rationale.netProceeds).toBe("14.00");
    expect(cappedDecision.unprofitable).toBe(false);

    const uncappedDecision = decision(profitPerDayGoal, {
      curve: peaks,
      economics: resolvedGoalEconomics(uncapped, hurdle),
    });
    expect(bruteForcePrice(uncapped)).toBe("12.00");
    expect(uncappedDecision.selectedPriceAmount).toBe(bruteForcePrice(uncapped));
    expect(uncappedDecision.rationale.netProceeds).toBe(independentNet(12, uncapped).toFixed(2));
  });

  it("selects the smallest loss regardless of wait, never discounting or flooring a loss", () => {
    const economics = resolvedGoalEconomics(fixedSixDollarTerms, 0.01);
    // Smallest loss at the slowest point: a floored loss would tie at zero and keep the fastest point.
    const slowLeastLoss = decision(profitPerDayGoal, {
      curve: curve([point(40, "4.00", 2), point(60, "5.00", 200)]),
      economics,
    });
    // Smallest loss at the fastest point: a discounted loss would shrink toward zero at the slow point.
    const fastLeastLoss = decision(profitPerDayGoal, {
      curve: curve([point(40, "4.00", 200), point(60, "5.00", 2)]),
      economics,
    });
    for (const result of [slowLeastLoss, fastLeastLoss]) {
      expect(result).toMatchObject({ selectedPriceAmount: "5.00", unprofitable: true });
      expect(result.rationale.netProceeds).toBe("-1.00");
    }
    expect(slowLeastLoss.forecast.medianSellDays).toBeCloseTo(200, 9);
    expect(fastLeastLoss.forecast.medianSellDays).toBeCloseTo(2, 9);
  });

  it("explains each goal with its table drivers, as values only", () => {
    const economics = resolvedGoalEconomics(typicalTerms, 0.005);
    const explain = (goal: PricingGoalDefinition, input: Partial<GoalSolveInput> = {}) => {
      const result = decision(goal, input);
      const explanation = goal.explain(result);
      expect(explanation).toMatchObject({
        goalId: goal.id,
        goalVersion: 1,
        parameters: result.rationale.parameters,
        equivalentPercentile: result.equivalentPercentile,
        forecast: result.forecast,
        unprofitable: result.unprofitable,
      });
      return explanation.drivers;
    };
    expect(explain(fixedPercentileGoal)).toEqual({ percentile: 65 });
    expect(explain(targetHorizonGoal, { parameters: { horizonDays: 14 } })).toEqual({
      horizonDays: 14,
      "forecast.status": "interpolated",
    });
    const profit = decision(profitPerDayGoal, { economics });
    expect(explain(profitPerDayGoal, { economics })).toEqual({
      dailyReturnHurdle: 0.005,
      netProceeds: profit.rationale.netProceeds,
    });
    expect(profit.rationale.netProceeds).toMatch(/^-?\d+\.\d{2}$/);
    expect(
      explain(profitPerDayGoal, {
        curve: curve([point(40, "4.00", 2), point(60, "5.00", 200)]),
        economics: resolvedGoalEconomics(fixedSixDollarTerms, 0.01),
      }),
    ).toEqual({ dailyReturnHurdle: 0.01, netProceeds: "-1.00" });
  });
});
