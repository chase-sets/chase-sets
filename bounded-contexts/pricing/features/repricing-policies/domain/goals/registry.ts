import type { MoneyAmount, SignedMoneyAmount } from "@chase-sets/primitives/money";
import type { EconomicsForPricingGoal } from "../../../economics/domain/resolution";
import type { CurvePoint } from "../../../market-estimates/domain/demand-curve/curve";
import type { PortfolioPlan, PortfolioSolveInput } from "../portfolio/portfolio";
import {
  decideAtPoint,
  netProceedsAtPrice,
  toGoalCurveViews,
  toMoneyAmount,
  toSignedMoneyAmount,
  type GoalCurvePoint,
  type GoalCurveViews,
  type GoalForecast,
} from "./curve-math";

export type GoalCurveFeature = "buyerArrivalIntervalDays" | "storeWinShare" | "medianSellDays";

export type GoalParameterBounds = Readonly<{ default: number; minimum: number; maximum: number }>;
export type GoalParameterSchema = Readonly<Record<string, GoalParameterBounds>>;
export type GoalParameters = Readonly<Record<string, number>>;

export type GoalParameterRejection = Readonly<{
  reason: "goal-parameter-unknown" | "goal-parameter-out-of-bounds";
  parameter: string;
}>;

export type GoalParameterValidation =
  | Readonly<{ kind: "valid"; parameters: GoalParameters }>
  | Readonly<{ kind: "rejected"; rejections: readonly GoalParameterRejection[] }>;

export type GoalCurve = Readonly<{ currencyCode: string; version: number; points: readonly CurvePoint[] }>;

type ResolvedEconomicsForPricingGoal = Extract<EconomicsForPricingGoal, { availability: "resolved" }>;

export type GoalSolveInput = Readonly<{
  curve: GoalCurve;
  economics: EconomicsForPricingGoal | null;
  parameters: GoalParameters;
  /** One copy at the listing's current price, in the curve currency; only a portfolio goal reads it. */
  currentPriceAmount?: MoneyAmount | null;
}>;

export type GoalDecision = Readonly<{
  kind: "decision";
  /** Money in the curve currency. No constraint runs inside a goal, so both amounts are equal here. */
  selectedPriceAmount: MoneyAmount;
  unconstrainedPriceAmount: MoneyAmount;
  equivalentPercentile: number;
  forecast: GoalForecast;
  /** Net Proceeds at the selected price do not clear unit overhead; always false for curve-only goals. */
  unprofitable: boolean;
  rationale: Readonly<{
    parameters: GoalParameters;
    dailyReturnHurdle: number | null;
    /** Signed Net Proceeds at the selected price, in the curve currency. */
    netProceeds: SignedMoneyAmount | null;
  }>;
}>;

export type GoalUnavailableReason =
  | "curve-empty"
  | `curve-feature-missing:${GoalCurveFeature}`
  | "economics-unavailable"
  | "economics-currency-mismatch"
  | "current-price-missing";

export type GoalUnavailable = Readonly<{ kind: "unavailable"; reason: GoalUnavailableReason }>;

export type GoalDriverValue = number | string | null;

/** Values only; seller-facing copy belongs to the surface that renders it. */
export type GoalExplanation = Readonly<{
  goalId: string;
  goalVersion: number;
  parameters: GoalParameters;
  equivalentPercentile: number;
  forecast: GoalForecast;
  unprofitable: boolean;
  drivers: Readonly<Record<string, GoalDriverValue>>;
}>;

export type PricingGoalDefinition = Readonly<{
  id: string;
  version: number;
  lifecycle: "shadow" | "selectable" | "retired";
  parameterSchema: GoalParameterSchema;
  requiredCurveFeatures: readonly GoalCurveFeature[];
  requiresEconomics: boolean;
  solve(input: GoalSolveInput): GoalDecision | GoalUnavailable;
  explain(decision: GoalDecision): GoalExplanation;
  /**
   * Portfolio goals only: one Portfolio Plan across an explicit listing set,
   * whose `solve` is then the plan of a one-listing portfolio. Callers resolve
   * a plan once and apply it per listing; a goal without it decides each
   * listing alone.
   */
  solvePortfolio?(input: PortfolioSolveInput): PortfolioPlan;
}>;

/** Fills defaults; an unknown key, or any value that is not a number within its inclusive bounds, is rejected. */
export function validateParameters(
  schema: GoalParameterSchema,
  parameters: Readonly<Record<string, unknown>>,
): GoalParameterValidation {
  const rejections: GoalParameterRejection[] = Object.keys(parameters)
    .filter((parameter) => !Object.hasOwn(schema, parameter))
    .sort()
    .map((parameter) => ({ reason: "goal-parameter-unknown", parameter }));
  const filled: Record<string, number> = {};
  for (const [parameter, bounds] of Object.entries(schema)) {
    const value = Object.hasOwn(parameters, parameter) ? parameters[parameter] : bounds.default;
    if (typeof value === "number" && value >= bounds.minimum && value <= bounds.maximum) filled[parameter] = value;
    else rejections.push({ reason: "goal-parameter-out-of-bounds", parameter });
  }
  return rejections.length > 0 ? { kind: "rejected", rejections } : { kind: "valid", parameters: filled };
}

type GoalEconomics<RequiresEconomics extends boolean> = RequiresEconomics extends true
  ? ResolvedEconomicsForPricingGoal
  : null;

type PricingGoalSpecification<Parameter extends string, RequiresEconomics extends boolean> = Readonly<{
  id: string;
  version: number;
  /** Reviewed registration change; selecting a later version cites graded adoption evidence. */
  lifecycle?: PricingGoalDefinition["lifecycle"];
  parameterSchema: Readonly<Record<Parameter, GoalParameterBounds>>;
  requiredCurveFeatures: readonly GoalCurveFeature[];
  requiresEconomics: RequiresEconomics;
  /** The requested curve point; `curve` already carries every required feature. */
  select(
    input: Readonly<{
      curve: GoalCurveViews;
      parameters: Readonly<Record<Parameter, number>>;
      economics: GoalEconomics<RequiresEconomics>;
    }>,
  ): GoalCurvePoint | GoalUnavailable;
  drivers(decision: GoalDecision): Readonly<Record<string, GoalDriverValue>>;
}>;

/**
 * Wraps a goal's point selection with the checks its declaration implies, in
 * this order: parameters (a rejection throws, since callers validate first),
 * `curve-empty`, `curve-feature-missing:<feature>` in declared order, then,
 * only when Economics is required, `economics-unavailable` before
 * `economics-currency-mismatch`. A goal that does not require Economics never
 * reads it. ISO codes compare case-insensitively and no amount is converted.
 * A goal that requires Economics reports the Daily Return Hurdle and signed
 * Net Proceeds at its selected price, and is unprofitable when they are not
 * positive.
 */
export function definePricingGoal<const Parameter extends string, const RequiresEconomics extends boolean>(
  specification: PricingGoalSpecification<Parameter, RequiresEconomics>,
): PricingGoalDefinition {
  const { id, version, parameterSchema, requiredCurveFeatures, requiresEconomics } = specification;
  return {
    id,
    version,
    lifecycle: specification.lifecycle ?? (version === 1 ? "selectable" : "shadow"),
    parameterSchema,
    requiredCurveFeatures,
    requiresEconomics,
    solve(input) {
      const parameters = requireValidParameters(`${id}@${version}`, parameterSchema, input.parameters) as Readonly<
        Record<Parameter, number>
      >;
      const curve = goalCurveViews(input.curve.points, requiredCurveFeatures);
      if ("kind" in curve) return curve;
      let economics: ResolvedEconomicsForPricingGoal | null = null;
      if (requiresEconomics) {
        const supplied = input.economics;
        if (supplied === null || supplied.availability !== "resolved") return unavailable("economics-unavailable");
        if (supplied.currency.toUpperCase() !== input.curve.currencyCode.toUpperCase())
          return unavailable("economics-currency-mismatch");
        economics = supplied;
      }
      const requested = specification.select({
        curve,
        parameters,
        economics: economics as GoalEconomics<RequiresEconomics>,
      });
      if ("kind" in requested) return requested;
      const { selectedPrice, equivalentPercentile, forecast } = decideAtPoint(curve, requested);
      const netProceeds = economics === null ? null : netProceedsAtPrice(selectedPrice, economics);
      return {
        kind: "decision",
        selectedPriceAmount: toMoneyAmount(selectedPrice),
        unconstrainedPriceAmount: toMoneyAmount(selectedPrice),
        equivalentPercentile,
        forecast,
        unprofitable: netProceeds !== null && netProceeds <= 0,
        rationale: {
          parameters,
          dailyReturnHurdle: economics === null ? null : economics.dailyReturnHurdle.effectiveValue,
          netProceeds: netProceeds === null ? null : toSignedMoneyAmount(netProceeds),
        },
      };
    },
    explain: (decision) => ({
      goalId: id,
      goalVersion: version,
      parameters: decision.rationale.parameters,
      equivalentPercentile: decision.equivalentPercentile,
      forecast: decision.forecast,
      unprofitable: decision.unprofitable,
      drivers: specification.drivers(decision),
    }),
  };
}

/** The filled parameters; a rejection throws, since callers validate first. */
export function requireValidParameters(
  goalVersion: string,
  schema: GoalParameterSchema,
  parameters: GoalParameters,
): GoalParameters {
  const validation = validateParameters(schema, parameters);
  if (validation.kind === "valid") return validation.parameters;
  const detail = validation.rejections.map((rejection) => `${rejection.reason} ${rejection.parameter}`);
  throw new Error(`Pricing Goal ${goalVersion} parameters were not validated: ${detail.join(", ")}.`);
}

/** A curve's sorted views, or the first reason it cannot be decided on: `curve-empty`, then each required feature in declared order. */
export function goalCurveViews(
  points: readonly CurvePoint[],
  requiredCurveFeatures: readonly GoalCurveFeature[],
): GoalCurveViews | GoalUnavailable {
  const curve = toGoalCurveViews(points);
  if (curve === null) return unavailable("curve-empty");
  const missing = requiredCurveFeatures.find((feature) => !curve.byPercentile.some((point) => point[feature] !== null));
  return missing === undefined ? curve : unavailable(`curve-feature-missing:${missing}`);
}

export function unavailable(reason: GoalUnavailableReason): GoalUnavailable {
  return { kind: "unavailable", reason };
}

const GOAL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Goals contribute decisions only; callers resolve one (id, version) and never switch on an id. */
export function createPricingGoalRegistry(initial: readonly PricingGoalDefinition[] = []) {
  const goals = new Map<string, PricingGoalDefinition>();
  const registerPricingGoal = (goal: PricingGoalDefinition): void => {
    if (!GOAL_ID_PATTERN.test(goal.id))
      throw new Error(`Pricing Goal id "${goal.id}" must match ${GOAL_ID_PATTERN.source}.`);
    if (!Number.isSafeInteger(goal.version) || goal.version < 1)
      throw new Error(`Pricing Goal ${goal.id} version must be a positive integer.`);
    for (const [parameter, bounds] of Object.entries(goal.parameterSchema)) {
      if (
        !Number.isFinite(bounds.minimum) ||
        !Number.isFinite(bounds.maximum) ||
        !(bounds.minimum <= bounds.default && bounds.default <= bounds.maximum)
      )
        throw new Error(
          `Pricing Goal ${goal.id} parameter ${parameter} needs a default within finite inclusive bounds.`,
        );
    }
    const key = `${goal.id}@${goal.version}`;
    if (goals.has(key)) throw new Error(`Pricing Goal ${key} is already registered.`);
    if (
      goal.lifecycle === "shadow" &&
      [...goals.values()].some((entry) => entry.id === goal.id && entry.lifecycle === "shadow")
    )
      throw new Error(`Pricing Goal ${goal.id} already has a shadow version.`);
    goals.set(key, goal);
  };
  initial.forEach(registerPricingGoal);
  return {
    registerPricingGoal,
    resolve: (id: string, version: number): PricingGoalDefinition | null => goals.get(`${id}@${version}`) ?? null,
    definitions: () => [...goals.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
  };
}
