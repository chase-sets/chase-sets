import { formatMachineValue, hasTranslation, t, type TranslationValues } from "@chase-sets/localization";
import type { GoalChoice, Recommendation } from "../api/goal-comparison";

export const healthCopy = (key: string, values?: TranslationValues) =>
  t(`pricing.features.pricingHealth.${key}`, values);
export const healthReasonLabel = (value: string) =>
  formatMachineValue(value, {
    knownValueTranslationKeys: {},
    family: healthCopy("reason"),
    translate: t,
    unrecognizedTranslationKey: "pricing.features.pricingHealth.reason.unknown",
    unrecognizedWithValueTranslationKey: "pricing.features.pricingHealth.reason.value",
  });
export const localizedGoalStatus = (value: string) =>
  hasTranslation(`pricing.features.pricingHealth.goals.statusValue.${value}`)
    ? healthCopy(`goals.statusValue.${value}`)
    : healthCopy("goals.statusValue.unknown");
export const healthNumber = (value: number | null) =>
  value === null
    ? healthCopy("unavailable")
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
export const healthPercent = (value: number | null) =>
  value === null
    ? healthCopy("unavailable")
    : new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(value);

export function goalLabel(goal: Pick<GoalChoice, "goalId" | "parameters">): string {
  const key = `goals.label.${goal.goalId}`;
  return hasTranslation(`pricing.features.pricingHealth.${key}`)
    ? healthCopy(key, goal.parameters)
    : healthCopy("goals.label.generic");
}

export function goalExplanation(goal: GoalChoice): string {
  const key = `goals.explanation.${goal.goalId}`;
  return !hasTranslation(`pricing.features.pricingHealth.${key}`)
    ? healthCopy("goals.explanation.generic", {
        features: goal.requiredCurveFeatures.map((feature) => healthCopy(`goals.feature.${feature}`)).join(", "),
        parameters: Object.entries(goal.parameters)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", "),
      })
    : healthCopy(key, goal.parameters);
}

export function recommendationCopy(recommendation: Recommendation, goals: readonly GoalChoice[]): string {
  const goal = goals.find(
    (goal) => goal.goalId === recommendation.goalId && goal.goalVersion === recommendation.goalVersion,
  );
  return healthCopy(
    `goals.recommendation.${recommendation.kind === "attention" ? recommendation.reason : recommendation.kind}`,
    {
      goal: goal ? goalLabel(goal) : healthCopy("goals.label.generic"),
      currency: recommendation.currency ?? "",
      delta: healthNumber(recommendation.delta ?? null),
      waitDelta: healthNumber(recommendation.waitDelta ?? null),
      raised: recommendation.raised ?? 0,
      lowered: recommendation.lowered ?? 0,
      held: recommendation.held ?? 0,
      count: recommendation.count ?? 0,
    },
  );
}
