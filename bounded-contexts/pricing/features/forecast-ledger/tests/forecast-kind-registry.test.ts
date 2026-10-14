import { describe, expect, it } from "vitest";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import {
  buyerChoiceForecastKind,
  conditionRateForecastKind,
  createForecastKindRegistry,
  curveForecastKind,
  forecastKindDefinitions,
  type ForecastCurve,
  type ForecastKindDefinition,
} from "../domain/forecast-kinds";
import { gradeLedgerScope, type GradedLedgerEntry } from "../domain/grade-ledger";
import { pricedLedgerEntries, toForecastLedgerEntries } from "../domain/ledger";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { evaluatedData, goalTrace, listingTrace } from "./fixtures/evaluated-event";

const DAY_MS = 24 * 60 * 60 * 1000;
const start = Date.parse("2026-08-01T00:00:00.000Z");
const { horizonsDays, graceDays } = FORECAST_LEDGER_LAUNCH_POLICY_VALUE;

const point = (percentile: number, priceAmount: string, storeWinShare: number): CurvePoint => ({
  percentile,
  priceAmount,
  buyerArrivalIntervalDays: 4,
  competingSellerCount: 6,
  storeWinShare,
  medianSellDays: (Math.LN2 * 4) / storeWinShare,
  qualifyingSaleCount: 12,
  historyCapped: false,
  hopeless: false,
  supplyStatus: "observed",
});
const curve: ForecastCurve = {
  modelVersion: "pooled-supply-v1",
  points: [point(25, "4.00", 0.5), point(75, "6.00", 0.2)],
  conditionSales: Array.from({ length: 52 }, (_, index) => ({
    weekStart: new Date(start - (index + 1) * 7 * DAY_MS).toISOString().slice(0, 10),
    transactionCount: 1,
  })),
};

/** A fourth model, registered only here: a week for every listing. */
const weekForecastKind: ForecastKindDefinition = {
  name: "flat-week",
  forecast: () => ({ medianSellDays: 7, model: "flat-week-v1" }),
};

/** Daily evaluations of three listings over sixty days; the first listing sells on day 25. */
function ledgerHistory(kinds: readonly ForecastKindDefinition[]): readonly GradedLedgerEntry[] {
  return Array.from({ length: 60 }, (_, day) =>
    evaluatedData(
      ["lst_a", "lst_b", "lst_c"].map((listingId) => listingTrace({ listingId })),
      { evaluationId: `evl_${day}`, evaluatedAt: new Date(start + day * DAY_MS).toISOString() },
    ),
  ).flatMap((data) =>
    toForecastLedgerEntries(pricedLedgerEntries(data), () => curve, kinds).map((entry) => ({
      listingId: entry.listingId,
      pricedAt: Date.parse(entry.pricedAt),
      quantity: entry.quantity,
      forecasts: entry.forecasts,
    })),
  );
}

const outcomes = {
  saleTimesByListing: new Map([["lst_a", [start + 25 * DAY_MS]]]),
  inStockListingIds: new Set(["lst_b", "lst_c"]),
};

describe("Forecast Kind registry", () => {
  it("registers the app's curve, buyer-choice, and condition-rate forecasts", () => {
    expect(forecastKindDefinitions().map((kind) => kind.name)).toEqual(["buyer-choice", "condition-rate", "curve"]);
    expect(forecastKindDefinitions()).toEqual([buyerChoiceForecastKind, conditionRateForecastKind, curveForecastKind]);
  });

  it("rejects a malformed or duplicate name", () => {
    const registry = createForecastKindRegistry();
    expect(() => registry.registerForecastKind({ ...weekForecastKind, name: "Flat Week" })).toThrow(/must match/);
    registry.registerForecastKind(weekForecastKind);
    expect(() => registry.registerForecastKind(weekForecastKind)).toThrow(/already registered/);
  });

  it("records and grades a fourth kind registered in a test with no change to the ledger or the job", () => {
    const registry = createForecastKindRegistry(forecastKindDefinitions());
    registry.registerForecastKind(weekForecastKind);
    const entries = ledgerHistory(registry.definitions());
    expect(Object.keys(entries[0]!.forecasts).sort()).toEqual(["buyer-choice", "condition-rate", "curve", "flat-week"]);
    const grades = gradeLedgerScope(entries, outcomes, {
      horizonsDays,
      graceDays,
      closedAt: start + 60 * DAY_MS,
    });
    const graded = (forecastKind: string) =>
      grades.filter((grade) => grade.forecastKind === forecastKind).map((grade) => grade.horizonDays);
    for (const forecastKind of ["buyer-choice", "condition-rate", "curve", "flat-week"]) {
      expect(graded(forecastKind)).toEqual(horizonsDays);
    }
    const week = grades.find((grade) => grade.forecastKind === "flat-week" && grade.horizonDays === 21)!;
    expect(week).toMatchObject({ model: "flat-week-v1", grade: { count: 3, soldShare: 1 / 3 } });
    expect(week.grade.expectedShare).toBeCloseTo(1 - 0.5 ** 3, 12);
    // Without the registration the same ledger and job grade only the three registered kinds.
    const registered = gradeLedgerScope(ledgerHistory(forecastKindDefinitions()), outcomes, {
      horizonsDays,
      graceDays,
      closedAt: start + 60 * DAY_MS,
    });
    expect([...new Set(registered.map((grade) => grade.forecastKind))]).toEqual([
      "buyer-choice",
      "condition-rate",
      "curve",
    ]);
  });

  it("never grades one model's forecasts beside another's, while either model's entry keeps the listing priced", () => {
    const entry = (day: number, model: string): GradedLedgerEntry => ({
      listingId: "lst_models",
      pricedAt: start + day * DAY_MS,
      quantity: 1,
      forecasts: { curve: { medianSellDays: model === "builder-v1" ? 5 : 50, model } },
    });
    // A builder upgrade between pricings: the old model's cohort keeps the listing priced through day 30.
    const entries = [entry(0, "builder-v1"), ...[10, 20, 30].map((day) => entry(day, "builder-v2"))];
    const grades = gradeLedgerScope(
      entries,
      { saleTimesByListing: new Map(), inStockListingIds: new Set(["lst_models"]) },
      { horizonsDays: [21], graceDays, closedAt: start + 31 * DAY_MS },
    );
    expect(grades.map(({ model, grade }) => ({ model, count: grade.count, soldShare: grade.soldShare }))).toEqual([
      { model: "builder-v1", count: 1, soldShare: 0 },
    ]);
    expect(grades[0]!.grade.expectedShare).toBeCloseTo(1 - 0.5 ** (21 / 5), 12);
  });

  it("takes the curve forecast only from an observed read-back under the curve's builder model", () => {
    const input = (status: "interpolated" | "unavailable", withCurve = true) => ({
      priceAmount: "5.00",
      pricedAt: new Date(start).toISOString(),
      goalForecast: { medianSellDays: goalTrace().forecastMedianSellDays, status },
      curve: withCurve ? curve : null,
    });
    expect(curveForecastKind.forecast(input("interpolated"))).toEqual({
      medianSellDays: 12,
      model: "pooled-supply-v1",
    });
    expect(curveForecastKind.forecast(input("unavailable"))).toBeNull();
    expect(curveForecastKind.forecast(input("interpolated", false))).toBeNull();
  });
});
