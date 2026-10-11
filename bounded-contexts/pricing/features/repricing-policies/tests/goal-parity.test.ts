import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixedPercentileGoal } from "../domain/goals/fixed-percentile";
import { profitPerDayGoal } from "../domain/goals/profit-per-day";
import { createPricingGoalRegistry, type GoalCurve } from "../domain/goals/registry";
import { targetHorizonGoal } from "../domain/goals/target-horizon";
import { resolvedGoalEconomics, type GoalFeeTerms } from "./fixtures/goal-economics";

type AppDecision = Readonly<{
  selectedPrice: number;
  unconstrainedPrice: number | null;
  equivalentPercentile: number | null;
  forecastStatus: string;
  unprofitable: boolean;
  estimatedMedianSellDays: number | null;
}>;

type OracleCase = Readonly<{
  curve: string;
  goalId: string;
  parameters: Readonly<Record<string, number>>;
  economics: Readonly<{ dailyReturnHurdle: number; feeTerms: string }> | null;
  decision: AppDecision | null;
}>;

const fixtureBytes = readFileSync(new URL("./fixtures/goal-parity-curve.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as { curves: Readonly<Record<string, GoalCurve>> };
const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/app-recorded-goal-oracle.json", import.meta.url), "utf8"),
) as Readonly<{
  sourceCommit: string;
  sourceBlobs: Readonly<Record<string, string>>;
  fixture: Readonly<{ file: string; sha256: string }>;
  feeTermSets: Readonly<Record<string, GoalFeeTerms>>;
  cases: readonly OracleCase[];
}>;
const registry = createPricingGoalRegistry([fixedPercentileGoal, targetHorizonGoal, profitPerDayGoal]);

const percentiles = Array.from({ length: 19 }, (_, index) => (index + 1) * 5);
const horizons = [7, 14, 30, 60, 90, 180];
const hurdles = [0.001, 0.005, 0.01, 0.02];

function caseKey(entry: OracleCase): string {
  return `${entry.curve} ${entry.goalId} ${JSON.stringify(entry.parameters)} ${JSON.stringify(entry.economics)}`;
}

function oracleDecision(curve: string, goalId: string, parameters: Readonly<Record<string, number>>): AppDecision {
  const entry = oracle.cases.find(
    (candidate) =>
      candidate.curve === curve &&
      candidate.goalId === goalId &&
      JSON.stringify(candidate.parameters) === JSON.stringify(parameters),
  );
  if (!entry?.decision) throw new Error(`No recorded app decision for ${curve} ${goalId}.`);
  return entry.decision;
}

describe("Pricing Goal parity with the pinned app", () => {
  it("records the pinned app commit, the five brief blobs plus the closure's horizonValueCurve, and this fixture", () => {
    expect(oracle.sourceCommit).toBe("bdeffa0190be035084abccb464716aaaa2541a59");
    expect(oracle.sourceBlobs).toEqual({
      "app/features/pricing/domain/pricingPolicy.ts": "36f40f8096ba9657118096b20e705c53fedfb7b8",
      "app/core/types/pricingPolicy.ts": "aa652940720ea8a923c3e7a9507e44ce0664bc2e",
      "app/features/pricing/domain/maximize.ts": "3e6b75f9b9a3dc67d135262bf3ae361ef81eaacd",
      "app/features/pricing/services/pricingService.ts": "72acf472e76c1603dd71b22b627270172e847cab",
      "app/core/types/pricing.ts": "8d72572cce52b4c504e50785e89750a952b803cd",
      "app/features/pricing/domain/horizonValueCurve.ts": "1d6ccccfa59b9a53876df4f41722bfe6355f7e87",
    });
    expect(oracle.fixture).toEqual({
      file: "goal-parity-curve.json",
      sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
    });
  });

  it("covers the acceptance grid on every fixture curve, with uncapped fee terms only", () => {
    const feeTerms = Object.keys(oracle.feeTermSets);
    expect(feeTerms.length).toBeGreaterThan(0);
    for (const terms of Object.values(oracle.feeTermSets)) {
      expect(terms.platformFeeCapPerUnitAmount).toBeNull();
      expect(terms.sellerHandlingCapPerUnitAmount).toBeNull();
    }
    const expected = Object.keys(fixture.curves).flatMap((curve) => [
      ...percentiles.map((percentile) => ({
        curve,
        goalId: "fixed-percentile",
        parameters: { percentile },
        economics: null,
      })),
      ...horizons.map((horizonDays) => ({
        curve,
        goalId: "target-horizon",
        parameters: { horizonDays },
        economics: null,
      })),
      ...feeTerms.flatMap((terms) =>
        hurdles.map((dailyReturnHurdle) => ({
          curve,
          goalId: "profit-per-day",
          parameters: {},
          economics: { dailyReturnHurdle, feeTerms: terms },
        })),
      ),
    ]);
    expect(oracle.cases.map(caseKey).sort()).toEqual(
      expected.map((entry) => caseKey({ ...entry, decision: null })).sort(),
    );
    expect(oracle.cases.filter((entry) => entry.decision?.unprofitable === true).length).toBeGreaterThan(0);
  });

  it("reproduces every recorded app decision within a cent and exactly on percentile, forecast status and profitability", () => {
    for (const entry of oracle.cases) {
      const goal = registry.resolve(entry.goalId, 1)!;
      const result = goal.solve({
        curve: fixture.curves[entry.curve]!,
        economics:
          entry.economics === null
            ? null
            : resolvedGoalEconomics(oracle.feeTermSets[entry.economics.feeTerms]!, entry.economics.dailyReturnHurdle),
        parameters: entry.parameters,
      });
      const label = caseKey(entry);
      if (entry.decision === null) {
        expect(result.kind, label).toBe("unavailable");
        continue;
      }
      if (result.kind !== "decision") throw new Error(`${label} returned ${result.reason}.`);
      expect(Math.abs(Number(result.selectedPriceAmount) - entry.decision.selectedPrice), label).toBeLessThanOrEqual(
        0.01,
      );
      expect(
        Math.abs(Number(result.unconstrainedPriceAmount) - entry.decision.unconstrainedPrice!),
        label,
      ).toBeLessThanOrEqual(0.01);
      expect(result.equivalentPercentile, label).toBe(entry.decision.equivalentPercentile);
      expect(result.forecast.status, label).toBe(entry.decision.forecastStatus);
      expect(result.unprofitable, label).toBe(entry.decision.unprofitable);
      expect(result.forecast.medianSellDays, label).toBe(entry.decision.estimatedMedianSellDays);
    }
  });

  it("has horizons where a median interpolated linearly would miss the recorded price by more than a cent", () => {
    const points = fixture.curves.observed!.points;
    const missed = horizons.filter((horizonDays) => {
      const upper = points.findIndex((point) => point.medianSellDays! >= horizonDays);
      const lower = points[upper - 1]!;
      const ratio = (horizonDays - lower.medianSellDays!) / (points[upper]!.medianSellDays! - lower.medianSellDays!);
      const linear =
        Number(lower.priceAmount) + (Number(points[upper]!.priceAmount) - Number(lower.priceAmount)) * ratio;
      const recorded = oracleDecision("observed", "target-horizon", { horizonDays }).selectedPrice;
      return Math.abs(Math.round(linear * 100) / 100 - recorded) > 0.01 + 1e-9;
    });
    expect(missed).toEqual([7, 60, 90, 180]);
  });
});
