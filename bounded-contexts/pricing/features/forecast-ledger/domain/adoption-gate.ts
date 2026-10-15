import type { PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";
import type { ForecastGrade } from "./grading";

export type AdoptionRefusal = "shadow-grade-missing" | "incumbent-grade-missing" | "shadow-grade-worse-than-incumbent";

/** A goal version's latest closed shadow grade beside its incumbent's, for the adopted forecast at one horizon. */
export type AdoptionGradePair = Readonly<{
  closedOn: string;
  forecastKind: string;
  model: string;
  horizonDays: number;
  shadow: ForecastGrade | null;
  incumbent: ForecastGrade | null;
}>;

export type AdoptionDecision =
  | Readonly<{ promotable: true; reason: null }>
  | Readonly<{ promotable: false; reason: AdoptionRefusal }>;

/** A shadow version is promotable only when its adopted forecast's Brier is at or below the incumbent's. */
export function decideAdoption(pair: AdoptionGradePair | null): AdoptionDecision {
  if (pair?.shadow == null) return { promotable: false, reason: "shadow-grade-missing" };
  if (pair.incumbent === null) return { promotable: false, reason: "incumbent-grade-missing" };
  return pair.shadow.brier <= pair.incumbent.brier
    ? { promotable: true, reason: null }
    : { promotable: false, reason: "shadow-grade-worse-than-incumbent" };
}

export type GoalAdoption = Readonly<{
  goalId: string;
  goalVersion: number;
  lifecycle: PricingGoalDefinition["lifecycle"];
  incumbentVersion: number | null;
  /** Whether a seller may choose this version now. */
  selectable: boolean;
  /** Whether its grade would let a reviewed registration change promote it. */
  promotable: boolean;
  reason: AdoptionRefusal | null;
  grades: AdoptionGradePair | null;
}>;

/**
 * The Adoption Gate over every registered goal version that is not retired.
 * Version 1 of a goal is selectable without a grade. Any later version is
 * graded against its incumbent, the newest earlier version that is not in
 * shadow: a shadow version reports whether it is promotable, and a version
 * registered selectable stays selectable only while its latest closed shadow
 * grade is at or better than the incumbent's. The gate never changes a
 * lifecycle; promotion stays a reviewed registration change citing the grade.
 */
export function goalAdoptions(
  definitions: readonly PricingGoalDefinition[],
  latestGrades: (goalId: string, goalVersion: number, incumbentVersion: number) => AdoptionGradePair | null,
): readonly GoalAdoption[] {
  return definitions
    .filter((goal) => goal.lifecycle !== "retired")
    .map((goal): GoalAdoption => {
      const identity = { goalId: goal.id, goalVersion: goal.version, lifecycle: goal.lifecycle };
      if (goal.version === 1) {
        const selectable = goal.lifecycle === "selectable";
        return { ...identity, incumbentVersion: null, selectable, promotable: selectable, reason: null, grades: null };
      }
      const incumbentVersion = definitions
        .filter((other) => other.id === goal.id && other.version < goal.version && other.lifecycle !== "shadow")
        .reduce<number | null>((newest, other) => Math.max(newest ?? 0, other.version), null);
      const grades = incumbentVersion === null ? null : latestGrades(goal.id, goal.version, incumbentVersion);
      const decision: AdoptionDecision =
        incumbentVersion === null ? { promotable: false, reason: "incumbent-grade-missing" } : decideAdoption(grades);
      return {
        ...identity,
        incumbentVersion,
        selectable: goal.lifecycle === "selectable" && decision.promotable,
        promotable: decision.promotable,
        reason: decision.reason,
        grades,
      };
    });
}
