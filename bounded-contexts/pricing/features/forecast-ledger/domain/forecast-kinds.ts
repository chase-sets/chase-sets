import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import type { RepricingGoalTrace } from "../../repricing-engine/domain/evaluate";
import { pointAtPrice, toGoalCurveViews, type GoalForecast } from "../../repricing-policies/domain/goals/curve-math";
import { BUYER_CHOICE_CALIBRATION, buyerChoiceInputs, estimateBuyerChoiceSellDays } from "./buyer-choice";
import {
  CONDITION_RATE_METHOD,
  conditionRateMedianSellDays,
  estimateConditionSaleIntervalDays,
  type ConditionSaleBucket,
} from "./condition-rate";

/** The Demand Curve version an evaluation read, with the sales of its own provider condition. */
export type ForecastCurve = Readonly<{
  modelVersion: string;
  points: readonly CurvePoint[];
  /** Weeks begun by the time the evaluation read its inputs, as observed then. */
  conditionSales: readonly ConditionSaleBucket[];
}>;

/** Everything a Forecast Kind may read for one evaluated price; every field is fixed when the price is evaluated. */
export type ForecastInput = Readonly<{
  priceAmount: string;
  pricedAt: string;
  /** The goal's read-back at this price; null when the entry's anchor resolved to no goal. */
  goalForecast: GoalForecast | null;
  curve: ForecastCurve | null;
}>;

/** A median sell time and the model that produced it; cohorts never mix models. */
export type Forecast = Readonly<{ medianSellDays: number; model: string }>;

/**
 * A sell-time forecast model. Registering one is the whole contract for adding
 * a forecast: the Forecast Ledger records it beside every entry and grading
 * scores it at every horizon, with no change to either.
 */
export type ForecastKindDefinition = Readonly<{
  name: string;
  /** The forecast at the entry's price, or null when the entry lacks a usable input. */
  forecast(input: ForecastInput): Forecast | null;
}>;

const FORECAST_KIND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function createForecastKindRegistry(initial: readonly ForecastKindDefinition[] = []) {
  const kinds = new Map<string, ForecastKindDefinition>();
  const registerForecastKind = (kind: ForecastKindDefinition): void => {
    if (!FORECAST_KIND_NAME_PATTERN.test(kind.name))
      throw new Error(`Forecast Kind "${kind.name}" must match ${FORECAST_KIND_NAME_PATTERN.source}.`);
    if (kinds.has(kind.name)) throw new Error(`Forecast Kind ${kind.name} is already registered.`);
    kinds.set(kind.name, kind);
  };
  initial.forEach(registerForecastKind);
  return {
    registerForecastKind,
    definitions: (): readonly ForecastKindDefinition[] =>
      [...kinds.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export type ForecastKindRegistry = ReturnType<typeof createForecastKindRegistry>;

/** An evaluated price, and the goal read-back that chose it when a goal did. */
export type EvaluatedPrice = Readonly<{
  targetPriceAmount: string | null;
  anchor: Readonly<{ goal?: RepricingGoalTrace }> | null;
}>;

/**
 * Takes every registered forecast at an evaluated price from the inputs its
 * evaluation read, so the evaluated fact carries them and the Forecast Ledger
 * never reads an input that changes later. A kind without a usable input is
 * absent; a trace without a price is left alone.
 */
export function withForecasts<Price extends EvaluatedPrice>(
  kinds: readonly ForecastKindDefinition[],
  price: Price,
  evaluation: Readonly<{ pricedAt: string; curve: ForecastCurve | null }>,
): Price & Readonly<{ forecasts?: Readonly<Record<string, Forecast>> }> {
  if (price.targetPriceAmount === null) return price;
  const goal = price.anchor?.goal;
  const input: ForecastInput = {
    priceAmount: price.targetPriceAmount,
    pricedAt: evaluation.pricedAt,
    goalForecast: goal ? { medianSellDays: goal.forecastMedianSellDays, status: goal.forecastStatus } : null,
    curve: evaluation.curve,
  };
  const forecasts: Record<string, Forecast> = {};
  for (const kind of kinds) {
    const forecast = kind.forecast(input);
    if (forecast !== null && Number.isFinite(forecast.medianSellDays) && forecast.medianSellDays > 0) {
      forecasts[kind.name] = forecast;
    }
  }
  return { ...price, forecasts };
}

/** The goal's own Demand Curve read-back, from an observed supply, under the curve's builder model. */
export const curveForecastKind: ForecastKindDefinition = {
  name: "curve",
  forecast: ({ goalForecast, curve }) =>
    curve !== null && goalForecast !== null && goalForecast.status !== "unavailable" && goalForecast.medianSellDays
      ? { medianSellDays: goalForecast.medianSellDays, model: curve.modelVersion }
      : null,
};

export const buyerChoiceForecastKind: ForecastKindDefinition = {
  name: "buyer-choice",
  forecast: ({ priceAmount, curve }) => {
    const inputs = curve === null ? null : buyerChoiceInputs(curve.points);
    const medianSellDays = inputs === null ? null : estimateBuyerChoiceSellDays(inputs, Number(priceAmount));
    return medianSellDays === null ? null : { medianSellDays, model: BUYER_CHOICE_CALIBRATION.name };
  },
};

/** The condition's own sale interval over the Store Win Share the curve reads at the entry's price. */
export const conditionRateForecastKind: ForecastKindDefinition = {
  name: "condition-rate",
  forecast: ({ priceAmount, pricedAt, curve }) => {
    const views = curve === null ? null : toGoalCurveViews(curve.points);
    if (curve === null || views === null) return null;
    const medianSellDays = conditionRateMedianSellDays(
      estimateConditionSaleIntervalDays(curve.conditionSales, Date.parse(pricedAt)),
      pointAtPrice(views, Number(priceAmount)).storeWinShare,
    );
    return medianSellDays === null ? null : { medianSellDays, model: CONDITION_RATE_METHOD };
  },
};

const forecastKindRegistry = createForecastKindRegistry([
  curveForecastKind,
  buyerChoiceForecastKind,
  conditionRateForecastKind,
]);

export const forecastKindDefinitions = forecastKindRegistry.definitions;
