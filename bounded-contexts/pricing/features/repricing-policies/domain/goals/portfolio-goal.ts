import { moneyToCents } from "@chase-sets/primitives/money";
import {
  buildPortfolioPlan,
  preparePortfolio,
  type PortfolioResolution,
  type PreparedPortfolio,
} from "../portfolio/portfolio";
import {
  goalCurveViews,
  requireValidParameters,
  unavailable,
  type GoalCurveFeature,
  type GoalDecision,
  type GoalDriverValue,
  type GoalParameterBounds,
  type PricingGoalDefinition,
} from "./registry";

type PortfolioGoalSpecification<Parameter extends string> = Readonly<{
  id: string;
  version: number;
  lifecycle?: PricingGoalDefinition["lifecycle"];
  parameterSchema: Readonly<Record<Parameter, GoalParameterBounds>>;
  requiredCurveFeatures: readonly GoalCurveFeature[];
  /** The one target horizon for the whole portfolio, and the values it reaches. */
  resolve(portfolio: PreparedPortfolio, parameters: Readonly<Record<Parameter, number>>): PortfolioResolution;
  drivers(decision: GoalDecision): Readonly<Record<string, GoalDriverValue>>;
}>;

/** The listing id a single-listing solve gives its one-listing portfolio. */
const SOLE_LISTING = "listing";

/**
 * A Pricing Goal decided across a portfolio. `solvePortfolio` resolves one
 * Portfolio Plan; `solve` is that plan for a one-listing portfolio at the
 * listing's current price, after the checks `definePricingGoal` runs in the
 * same order: parameters (a rejection throws), `curve-empty`,
 * `curve-feature-missing:<feature>` in declared order, then
 * `current-price-missing`. A portfolio goal never reads Economics.
 */
export function definePortfolioGoal<const Parameter extends string>(
  specification: PortfolioGoalSpecification<Parameter>,
): PricingGoalDefinition {
  const { id, version, parameterSchema, requiredCurveFeatures } = specification;
  const goalVersion = `${id}@${version}`;
  const solvePortfolio: NonNullable<PricingGoalDefinition["solvePortfolio"]> = (input) => {
    const parameters = requireValidParameters(goalVersion, parameterSchema, input.parameters);
    const portfolio = preparePortfolio(input, requiredCurveFeatures);
    return buildPortfolioPlan(
      { id, version },
      parameters,
      portfolio,
      specification.resolve(portfolio, parameters as Readonly<Record<Parameter, number>>),
    );
  };
  return {
    id,
    version,
    lifecycle: specification.lifecycle ?? (version === 1 ? "selectable" : "shadow"),
    parameterSchema,
    requiredCurveFeatures,
    requiresEconomics: false,
    solve(input) {
      const parameters = requireValidParameters(goalVersion, parameterSchema, input.parameters);
      const curve = goalCurveViews(input.curve.points, requiredCurveFeatures);
      if ("kind" in curve) return curve;
      const currentPriceAmount = input.currentPriceAmount ?? null;
      if (currentPriceAmount === null || moneyToCents(currentPriceAmount) <= 0n)
        return unavailable("current-price-missing");
      const [sole] = solvePortfolio({
        currencyCode: input.curve.currencyCode,
        listings: [{ listingId: SOLE_LISTING, currentPriceAmount, curve: input.curve }],
        parameters,
      }).listings;
      return sole!.decision ?? unavailable(sole!.heldReason!);
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
    solvePortfolio,
  };
}
