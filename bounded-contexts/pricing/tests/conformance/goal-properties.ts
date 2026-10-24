import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";
import { evaluateRepricingListing } from "../../features/repricing-engine/domain/evaluate";
import { evaluateShadowGoals } from "../../features/repricing-engine/domain/round";
import {
  goalDirective,
  goalListing,
  goalSnapshot,
  typicalFeeTerms,
} from "../../features/repricing-engine/tests/curve-objective-fixture";
import { registerShadowGoals } from "../../features/repricing-engine/tests/shadow-goal-fixture";
import { pricingGoalDefinitions } from "../../features/repricing-policies/domain/domain";
import {
  validateParameters,
  type GoalCurve,
  type GoalCurveFeature,
  type GoalDecision,
  type GoalParameters,
  type GoalUnavailable,
  type PricingGoalDefinition,
} from "../../features/repricing-policies/domain/goals/registry";
import type { PortfolioListing } from "../../features/repricing-policies/domain/portfolio/portfolio";
import {
  resolvedGoalEconomics,
  unavailableGoalEconomics,
} from "../../features/repricing-policies/tests/fixtures/goal-economics";
import { deepFreeze, type ConformanceProperty } from "./kit";

/** The shared fixture curves every goal is judged on: the #9307 parity curves, read as the app recorded them. */
export const fixtureCurves = (
  JSON.parse(
    readFileSync(
      new URL("../../features/repricing-policies/tests/fixtures/goal-parity-curve.json", import.meta.url),
      "utf8",
    ),
  ) as { curves: Readonly<Record<string, GoalCurve>> }
).curves;

/** Resolved Economics for every goal that requires it: the parity fee terms at a 1% Daily Return Hurdle. */
export const fixtureEconomics = resolvedGoalEconomics(typicalFeeTerms, 0.01);

/** The fixture listing's current price, as the engine passes it; only a portfolio goal reads it. */
export const fixtureCurrentPriceAmount = normalizeMoneyAmount(goalListing().currentPriceAmount);

export type GoalResult = GoalDecision | GoalUnavailable;

/** What a goal registration states beside its module, kept with the kit and reviewed with every version. */
export type GoalDeclaration = Readonly<{
  /** Scaling every curve price up never lowers the goal's price, and scaling down never raises it. */
  priceScalesWithCurve: boolean;
  /** The Golden Decision on each shared fixture curve at default parameters, as plain reviewed data. */
  golden: Readonly<Record<string, object>>;
}>;

/** Keyed by Goal Version: `<id>@<version>`. */
export type GoalDeclarations = Readonly<Record<string, GoalDeclaration>>;

export const goalVersionKey = (goal: Pick<PricingGoalDefinition, "id" | "version">): string =>
  `${goal.id}@${goal.version}`;

export function defaultParameters(goal: PricingGoalDefinition): GoalParameters {
  return Object.fromEntries(Object.entries(goal.parameterSchema).map(([name, bounds]) => [name, bounds.default]));
}

export function solveOnFixture(
  goal: PricingGoalDefinition,
  curve: GoalCurve,
  overrides: Readonly<{ parameters?: GoalParameters; economics?: typeof fixtureEconomics | null }> = {},
): GoalResult {
  return goal.solve({
    curve,
    parameters: overrides.parameters ?? defaultParameters(goal),
    economics:
      overrides.economics !== undefined ? overrides.economics : goal.requiresEconomics ? fixtureEconomics : null,
    currentPriceAmount: fixtureCurrentPriceAmount,
  });
}

/**
 * A portfolio over the shared fixture curves: the observed curve at the
 * fixture price and rescaled, the truncated-supply curve no goal can model,
 * and an observed listing with no current price.
 */
function fixturePortfolio(): readonly PortfolioListing[] {
  const observed = fixtureCurves.observed!;
  const scaled = { ...observed, points: scaleCurve(observed, 1.5).points };
  return [
    { listingId: "lst_conformance_a", currentPriceAmount: fixtureCurrentPriceAmount, curve: observed },
    { listingId: "lst_conformance_b", currentPriceAmount: normalizeMoneyAmount("14.00"), curve: scaled },
    {
      listingId: "lst_conformance_c",
      currentPriceAmount: normalizeMoneyAmount("12.00"),
      curve: fixtureCurves["truncated-supply"]!,
    },
    { listingId: "lst_conformance_d", currentPriceAmount: null, curve: observed },
  ];
}

function declarationOf(declarations: GoalDeclarations, goal: PricingGoalDefinition): GoalDeclaration {
  const declaration = declarations[goalVersionKey(goal)];
  if (!declaration) throw new Error(`${goalVersionKey(goal)} has no declaration and Golden Decision in the kit.`);
  return declaration;
}

function scaleCurve(curve: GoalCurve, factor: number): GoalCurve {
  return {
    ...curve,
    points: curve.points.map((point) => ({ ...point, priceAmount: (Number(point.priceAmount) * factor).toFixed(2) })),
  };
}

/** Clears a feature on every point; a sell time also loses the inputs it is derived from. */
function withoutFeature(curve: GoalCurve, feature: GoalCurveFeature): GoalCurve {
  const cleared: readonly GoalCurveFeature[] =
    feature === "medianSellDays" ? ["buyerArrivalIntervalDays", "storeWinShare", "medianSellDays"] : [feature];
  return {
    ...curve,
    points: curve.points.map((point) => ({ ...point, ...Object.fromEntries(cleared.map((name) => [name, null])) })),
  };
}

function parameterExtremes(goal: PricingGoalDefinition): readonly GoalParameters[] {
  const defaults = defaultParameters(goal);
  return Object.entries(goal.parameterSchema).flatMap(([name, bounds]) => [
    { ...defaults, [name]: bounds.minimum },
    { ...defaults, [name]: bounds.maximum },
  ]);
}

function expectExplained(goal: PricingGoalDefinition, result: GoalResult): void {
  if (result.kind !== "decision") return;
  const explanation = goal.explain(result);
  expect(explanation).toMatchObject({
    goalId: goal.id,
    goalVersion: goal.version,
    parameters: result.rationale.parameters,
    equivalentPercentile: result.equivalentPercentile,
    forecast: result.forecast,
    unprofitable: result.unprofitable,
  });
  for (const [driver, value] of Object.entries(explanation.drivers))
    expect(
      value === null || typeof value === "string" || Number.isFinite(value),
      `driver ${driver} is a value, not copy or an object`,
    ).toBe(true);
}

export const goldenDecisionProperty = (declarations: GoalDeclarations): ConformanceProperty<PricingGoalDefinition> => ({
  name: "reproduces its Golden Decision on the shared fixture curves",
  check: (goal) => {
    const { golden } = declarationOf(declarations, goal);
    for (const [name, curve] of Object.entries(fixtureCurves))
      expect(
        solveOnFixture(goal, curve),
        `${goalVersionKey(goal)} changed its decision on the ${name} fixture curve; a changed decision is a new Goal Version`,
      ).toEqual(golden[name]);
  },
});

/** The goal contract (#9307, lifecycle #9310); every property reads only the registered definition. */
export function goalConformanceProperties(
  declarations: GoalDeclarations,
): readonly ConformanceProperty<PricingGoalDefinition>[] {
  return [
    {
      name: "declares its curve claims and a Golden Decision on every fixture curve",
      check: (goal) => {
        expect(Object.keys(declarationOf(declarations, goal).golden).sort()).toEqual(Object.keys(fixtureCurves).sort());
      },
    },
    {
      name: "decides deterministically over frozen captured inputs",
      check: (goal) => {
        for (const curve of Object.values(fixtureCurves)) {
          const input = deepFreeze({
            curve: structuredClone(curve),
            parameters: defaultParameters(goal),
            economics: goal.requiresEconomics ? structuredClone(fixtureEconomics) : null,
            currentPriceAmount: fixtureCurrentPriceAmount,
          });
          const first = goal.solve(input);
          expect(goal.solve(input)).toEqual(first);
          expect(solveOnFixture(goal, curve)).toEqual(first);
          if (first.kind === "decision") expect(goal.explain(first)).toEqual(goal.explain(first));
        }
      },
    },
    {
      name: "validates parameters with defaults inside finite bounds",
      check: (goal) => {
        expect(validateParameters(goal.parameterSchema, {})).toEqual({
          kind: "valid",
          parameters: defaultParameters(goal),
        });
        expect(validateParameters(goal.parameterSchema, { "conformance-unknown": 1 })).toMatchObject({
          kind: "rejected",
          rejections: [{ reason: "goal-parameter-unknown", parameter: "conformance-unknown" }],
        });
        for (const [name, bounds] of Object.entries(goal.parameterSchema)) {
          expect([bounds.minimum, bounds.maximum].every(Number.isFinite), `${name} bounds are finite`).toBe(true);
          expect(bounds.minimum <= bounds.default && bounds.default <= bounds.maximum, `${name} default`).toBe(true);
          for (const outside of [bounds.minimum - 1, bounds.maximum + 1, Number.NaN])
            expect(validateParameters(goal.parameterSchema, { [name]: outside })).toMatchObject({
              kind: "rejected",
              rejections: [{ reason: "goal-parameter-out-of-bounds", parameter: name }],
            });
        }
        for (const parameters of parameterExtremes(goal))
          for (const curve of Object.values(fixtureCurves))
            expectExplained(goal, solveOnFixture(goal, curve, { parameters }));
      },
    },
    {
      name: "answers a stable unavailable result for each missing input it declares",
      check: (goal) => {
        const curve = fixtureCurves.observed!;
        const unavailable = (result: GoalResult, reason: string) =>
          expect(result).toEqual({ kind: "unavailable", reason });
        unavailable(solveOnFixture(goal, { ...curve, points: [] }), "curve-empty");
        for (const feature of goal.requiredCurveFeatures) {
          const cleared = withoutFeature(curve, feature);
          const expected = goal.requiredCurveFeatures.find((declared) =>
            cleared.points.every((point) => point[declared] === null),
          );
          unavailable(solveOnFixture(goal, cleared), `curve-feature-missing:${expected}`);
          expect(solveOnFixture(goal, cleared)).toEqual(solveOnFixture(goal, cleared));
        }
        if (goal.requiresEconomics) {
          unavailable(solveOnFixture(goal, curve, { economics: null }), "economics-unavailable");
          unavailable(solveOnFixture(goal, curve, { economics: unavailableGoalEconomics() }), "economics-unavailable");
          unavailable(
            solveOnFixture(goal, curve, { economics: resolvedGoalEconomics(typicalFeeTerms, 0.01, "eur") }),
            "economics-currency-mismatch",
          );
        } else {
          expect(solveOnFixture(goal, curve, { economics: fixtureEconomics })).toEqual(
            solveOnFixture(goal, curve, { economics: null }),
          );
        }
      },
    },
    {
      name: "responds monotonically to curve prices where it claims to",
      check: (goal) => {
        if (!declarationOf(declarations, goal).priceScalesWithCurve) return;
        for (const [name, curve] of Object.entries(fixtureCurves)) {
          const base = solveOnFixture(goal, curve);
          for (const factor of [0.8, 1.25]) {
            const scaled = solveOnFixture(goal, scaleCurve(curve, factor));
            if (base.kind !== "decision" || scaled.kind !== "decision") {
              expect(scaled, `${name} x${factor}`).toEqual(base);
              continue;
            }
            const [lower, upper] = factor < 1 ? [scaled, base] : [base, scaled];
            expect(
              Number(lower.selectedPriceAmount) <= Number(upper.selectedPriceAmount),
              `${name} x${factor}: ${base.selectedPriceAmount} -> ${scaled.selectedPriceAmount}`,
            ).toBe(true);
          }
        }
      },
    },
    {
      name: "explains every decision with its own identity and values",
      check: (goal) => {
        let decisions = 0;
        for (const curve of Object.values(fixtureCurves)) {
          const result = solveOnFixture(goal, curve);
          if (result.kind === "decision") decisions += 1;
          expectExplained(goal, result);
        }
        expect(decisions, "at least one fixture curve yields a decision to explain").toBeGreaterThan(0);
      },
    },
    {
      name: "runs in shadow without changing the incumbent's evaluation",
      check: (goal) => {
        if (goal.lifecycle === "retired") return;
        const registered = pricingGoalDefinitions().filter((definition) => definition.id === goal.id);
        const incumbent = registered.find((definition) => definition.lifecycle === "selectable");
        if (!incumbent) throw new Error(`${goal.id} has no selectable version for a shadow to run beside.`);
        const shadow =
          goal.lifecycle === "shadow"
            ? goal
            : {
                ...goal,
                version: Math.max(...registered.map(({ version }) => version)) + 1,
                lifecycle: "shadow" as const,
              };
        const listing = goalListing(
          goalDirective({
            anchorChain: [
              {
                source: "curve-objective",
                goalId: incumbent.id,
                goalVersion: incumbent.version,
                parameters: defaultParameters(incumbent),
              },
            ],
          }),
        );
        const snapshot = goalSnapshot({ economics: goal.requiresEconomics ? fixtureEconomics : null });
        const before = JSON.stringify(evaluateRepricingListing(listing, snapshot));
        try {
          if (!registered.includes(shadow)) registerShadowGoals([shadow]);
          expect(evaluateShadowGoals(listing, snapshot, [shadow])).toEqual([
            expect.objectContaining({ goalId: goal.id, goalVersion: shadow.version, anchorIndex: 0, skipped: null }),
          ]);
          expect(JSON.stringify(evaluateRepricingListing(listing, snapshot))).toBe(before);
        } finally {
          vi.restoreAllMocks();
        }
      },
    },
    {
      name: "solves a portfolio as one reproducible plan where it declares one",
      check: (goal) => {
        if (!goal.solvePortfolio) return;
        const listings = deepFreeze(structuredClone(fixturePortfolio()));
        const input = { currencyCode: "USD", listings, parameters: defaultParameters(goal) };
        const plan = goal.solvePortfolio(input);
        expect(goal.solvePortfolio({ ...input, listings: [...listings].reverse() }), "order-free").toEqual(plan);
        expect(plan).toMatchObject({ goalId: goal.id, goalVersion: goal.version, parameters: input.parameters });
        expect(plan.listings.map(({ listingId }) => listingId)).toEqual(listings.map(({ listingId }) => listingId));
        expect(plan.listings.slice(2), "held, never guessed").toEqual([
          {
            listingId: "lst_conformance_c",
            planPriceAmount: "12.00",
            decision: null,
            heldReason: expect.stringMatching(/^curve-/),
          },
          {
            listingId: "lst_conformance_d",
            planPriceAmount: null,
            decision: null,
            heldReason: "current-price-missing",
          },
        ]);
        for (const { decision } of plan.listings) if (decision) expectExplained(goal, decision);
        const [single] = goal.solvePortfolio({ ...input, listings: [listings[0]!] }).listings;
        expect(solveOnFixture(goal, listings[0]!.curve!), "one listing is a one-listing portfolio").toEqual(
          single!.decision,
        );
        expect(() => goal.solvePortfolio!({ ...input, listings: [...listings, listings[0]!] })).toThrow(
          "A portfolio lists each listing once; repeated: lst_conformance_a.",
        );
      },
    },
    goldenDecisionProperty(declarations),
  ];
}
