import { describe, expect, it } from "vitest";
import { buyerChoiceForecastKind, conditionRateForecastKind } from "../domain/forecast-kinds";
import { BUYER_CHOICE_CALIBRATION } from "../domain/buyer-choice";
import { buildForecastCohort } from "../domain/cohort";
import { CONDITION_RATE_METHOD, estimateConditionSaleIntervalDays } from "../domain/condition-rate";
import { gradeForecast, saleProbability } from "../domain/grading";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { appRecordsAsLedger, oracle } from "./fixtures/app-oracle";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";

const { graceDays } = FORECAST_LEDGER_LAUNCH_POLICY_VALUE;

function curvePoint(point: Partial<CurvePoint> & Pick<CurvePoint, "percentile">): CurvePoint {
  return {
    priceAmount: "1.00",
    buyerArrivalIntervalDays: null,
    competingSellerCount: null,
    storeWinShare: null,
    medianSellDays: null,
    qualifyingSaleCount: 0,
    historyCapped: false,
    hopeless: false,
    supplyStatus: "observed",
    ...point,
  };
}

describe("Forecast Grade parity with the app's gradeForecast", () => {
  it("the median sells half the time", () => {
    expect(saleProbability(21, 21)).toBeCloseTo(0.5, 12);
  });

  const cases = oracle.cohort.cohorts.flatMap((cohort) =>
    oracle.cohort.forecastNames.map((name) => [name, cohort.horizonDays, cohort.grades[name]!] as const),
  );
  it.each(cases)(
    "reproduces the app's %s grade at %i days and reports Brier beside the base rate",
    (name, horizonDays, recorded) => {
      const { entries, outcomes } = appRecordsAsLedger();
      const cohort = buildForecastCohort(entries, oracle.cohort.forecastNames, outcomes, { horizonDays, graceDays });
      const grade = gradeForecast(cohort, name, horizonDays)!;
      expect(grade.count).toBe(recorded.count);
      expect(grade.soldShare).toBeCloseTo(recorded.soldShare, 12);
      expect(grade.expectedShare).toBeCloseTo(recorded.expectedShare, 12);
      expect(grade.brier).toBeCloseTo(recorded.brier, 12);
      expect(grade.deciles).toHaveLength(recorded.deciles.length);
      grade.deciles.forEach((decile, index) => {
        const expected = recorded.deciles[index]!;
        expect(decile.count).toBe(expected.count);
        expect(decile.medianDays).toBe(expected.medianDays);
        expect(decile.soldShare).toBeCloseTo(expected.soldShare, 12);
        expect(decile.expectedShare).toBeCloseTo(expected.expectedShare, 12);
      });
      // Forecasting the sold share for everyone scores soldShare x (1 - soldShare).
      expect(grade.baseRateBrier).toBeCloseTo(recorded.soldShare * (1 - recorded.soldShare), 12);
    },
  );

  it("an empty cohort has no grade rather than a grade of zeros", () => {
    expect(gradeForecast([], "curve", 21)).toBeNull();
  });
});

describe("Forecast Kind parity with the app's forecast models", () => {
  it.each(oracle.buyerChoice.flatMap((entry) => entry.forecasts.map((forecast) => [entry.curve, forecast] as const)))(
    "buyer-choice reproduces the app's forecast",
    (curve, { price, forecast }) => {
      const result = buyerChoiceForecastKind.forecast({
        priceAmount: price.toFixed(2),
        pricedAt: "2026-08-12T15:00:00.000Z",
        goalForecast: null,
        curve: { modelVersion: "synthetic-curve-model", points: curve.map(curvePoint), conditionSales: [] },
      });
      if (forecast === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result!.model).toBe(forecast.calibration);
      expect(result!.model).toBe(BUYER_CHOICE_CALIBRATION.name);
      expect(result!.medianSellDays).toBeCloseTo(forecast.medianSellDays, 9);
    },
  );

  it.each(oracle.conditionRate.flatMap((entry) => entry.forecasts.map((forecast) => [entry, forecast] as const)))(
    "condition-rate reproduces the app's forecast",
    (entry, { storeWinShare, medianSellDays }) => {
      const interval = estimateConditionSaleIntervalDays(entry.buckets, Date.parse(entry.asOf));
      if (entry.intervalDays === null) expect(interval).toBeNull();
      else expect(interval).toBeCloseTo(entry.intervalDays, 12);
      const result = conditionRateForecastKind.forecast({
        priceAmount: "5.00",
        pricedAt: entry.asOf,
        goalForecast: null,
        curve: {
          modelVersion: "synthetic-curve-model",
          points: [curvePoint({ percentile: 50, priceAmount: "5.00", storeWinShare })],
          conditionSales: entry.buckets,
        },
      });
      if (medianSellDays === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result).toEqual({ medianSellDays: expect.closeTo(medianSellDays, 9), model: CONDITION_RATE_METHOD });
    },
  );

  it("reads a week as seven days when weeks without a sale are not stored", () => {
    const asOf = Date.parse("2026-08-12T15:00:00.000Z");
    // Only two weeks sold, eleven weeks apart: the app would have measured an eleven-week bucket.
    const interval = estimateConditionSaleIntervalDays(
      [
        { weekStart: "2026-05-25", transactionCount: 2 },
        { weekStart: "2026-08-10", transactionCount: 1 },
      ],
      asOf,
    );
    const yearRate = 3 / 364;
    const quarterRate = 3 / 91;
    expect(interval).toBeCloseTo(1 / ((yearRate + quarterRate) / 2), 12);
  });
});
