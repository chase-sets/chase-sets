import { describe, expect, it } from "vitest";
import {
  buildCandidateBody,
  isOneRuleUnconditional,
  recommendGoalChange,
  selectableGoalChoices,
} from "../api/goal-comparison";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";

describe("Pricing Health goal comparison", () => {
  it("offers only Adoption Gate selectable versions and fills schema defaults", () => {
    const choices = selectableGoalChoices(pricingGoalDefinitions(), [
      {
        goalId: "fixed-percentile",
        goalVersion: 1,
        lifecycle: "selectable",
        incumbentVersion: null,
        selectable: true,
        promotable: true,
        reason: null,
        grades: null,
      },
      {
        goalId: "target-horizon",
        goalVersion: 1,
        lifecycle: "selectable",
        incumbentVersion: null,
        selectable: false,
        promotable: false,
        reason: "incumbent-grade-missing",
        grades: null,
      },
    ]);
    expect(choices.map((choice) => choice.goalId)).toEqual(["fixed-percentile"]);
    expect(choices[0]?.parameters).toEqual({ percentile: 65 });
  });

  it("replaces only the complete anchor chain while preserving every other directive field", () => {
    const target = {
      scope: { kind: "all-listings" as const },
      excludedListingIds: ["lst_excluded"],
      maxChangesPerDay: 5,
      rules: [
        {
          conditions: [],
          directive: {
            currencyCode: "USD",
            anchorChain: [{ source: "market-estimate" as const }, { source: "last-sold" as const }],
            guardrails: [{ kind: "market-evidence-floor" as const, percentOfEstimate: 90 }],
            offset: { mode: "percent" as const, percent: 2 },
            floor: { mode: "absolute" as const, amount: "4.00" },
            ceiling: { mode: "percent" as const, percent: 130 },
            tolerance: { mode: "absolute" as const, amount: "0.10" },
            rounding: { mode: "none" as const },
            maxMovePercent: 10,
            terminal: { kind: "hold" as const },
          },
        },
      ],
    };
    const body = buildCandidateBody(target, {
      goalId: "fixed-percentile",
      goalVersion: 1,
      parameters: { percentile: 65 },
    });
    expect(isOneRuleUnconditional(body.rules)).toBe(true);
    expect(body.rules[0]?.directive.anchorChain).toEqual([
      { source: "curve-objective", goalId: "fixed-percentile", goalVersion: 1, parameters: { percentile: 65 } },
    ]);
    expect(body.rules[0]?.directive.floor).toEqual(target.rules[0]!.directive.floor);
    expect(body.rules[0]?.directive.guardrails).toEqual(target.rules[0]!.directive.guardrails);
  });

  it("returns one deterministic recommendation and refuses incomplete comparisons", () => {
    const health = {
      currencies: {
        USD: {
          profitPerDay: { value: 2 },
          coverage: { listingRatio: 1 },
          valueAtRisk: { hopeless: { valueAmount: "0" }, slow: { valueAmount: "0" } },
          curveAge: { staleCount: 0 },
        },
      },
    };
    const recommendation = recommendGoalChange({
      currentHealth: health,
      currentEconomicsSet: { digest: "synthetic-a", size: 1 },
      haltEngaged: false,
      candidates: [
        {
          goalId: "target-horizon",
          goalVersion: 1,
          dryRunId: "run",
          status: "completed",
          requestedAt: "now",
          completedAt: "now",
          bodyHash: "hash",
          targetPolicyId: "rpp",
          targetRevision: 1,
          listingCount: 1,
          raised: 1,
          lowered: 0,
          held: 0,
          value: { USD: "10.00" },
          medianWaitDays: { USD: 3 },
          p90WaitDays: { USD: 4 },
          coverage: { USD: 1 },
          profitPerDay: { USD: 3 },
          economicsSet: { digest: "synthetic-a", size: 1 },
          capitalTurn: { USD: 0.1 },
          boundStatusCount: { USD: 0 },
          heldReasons: {},
          flags: {},
        },
      ],
    });
    expect(recommendation.kind).toBe("switch");
    expect(
      recommendGoalChange({
        currentHealth: health,
        currentEconomicsSet: { digest: "synthetic-empty", size: 0 },
        haltEngaged: false,
        candidates: [],
      }).kind,
    ).toBe("compare-goals");
  });

});
