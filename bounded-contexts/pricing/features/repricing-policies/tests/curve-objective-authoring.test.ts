import { describe, expect, it } from "vitest";
import {
  decideRepricingPolicy,
  evolveRepricingPolicy,
  initialRepricingPolicyState,
  RepricingPolicyValidationError,
  type RepricingAnchor,
  type RepricingRuleDirective,
} from "../domain/domain";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { validateRepricingDryRunBody } from "../../repricing-engine/api/dry-run";

const goal: RepricingAnchor = { source: "curve-objective", goalId: "fixed-percentile", goalVersion: 1, parameters: {} };
const directive = (overrides: Partial<RepricingRuleDirective> = {}): RepricingRuleDirective => ({
  ...dryRunBody.rules[0]!.directive,
  anchorChain: [goal],
  ...overrides,
});
const command = (value: RepricingRuleDirective) => ({
  ...dryRunBody,
  type: "CreateRepricingPolicy" as const,
  policyId: "rpp_synthetic" as never,
  accountId: "acc_synthetic" as never,
  name: "Synthetic goal policy",
  createdAt: "2026-10-13T00:00:00Z",
  rules: [{ conditions: [], directive: value }],
});

describe("curve-objective authoring", () => {
  it("fills defaults into both created and revised recorded bodies, and dry-run candidates", () => {
    const created = decideRepricingPolicy(initialRepricingPolicyState, command(directive()));
    const state = created.reduce(evolveRepricingPolicy, initialRepricingPolicyState);
    expect(state.rules[0]!.directive.anchorChain).toEqual([{ ...goal, parameters: { percentile: 65 } }]);
    expect(state.rules[0]!.directive).not.toHaveProperty("guardrails");
    const revised = decideRepricingPolicy(state, {
      type: "ReviseRepricingPolicy",
      name: state.name!,
      scope: state.scope!,
      excludedListingIds: [],
      rules: [
        {
          conditions: [],
          directive: directive({
            anchorChain: [{ source: "curve-objective", goalId: "target-horizon", goalVersion: 1, parameters: {} }],
            guardrails: [{ kind: "hopeless-forecast-hold" }, { kind: "market-evidence-floor", percentOfEstimate: 90 }],
          }),
        },
      ],
      maxChangesPerDay: 100,
      revisedAt: "2026-10-14T00:00:00Z",
    }).reduce(evolveRepricingPolicy, state);
    expect(revised.rules[0]!.directive.anchorChain[0]).toEqual({
      source: "curve-objective",
      goalId: "target-horizon",
      goalVersion: 1,
      parameters: { horizonDays: 30 },
    });
    expect(revised.rules[0]!.directive.guardrails).toEqual([
      { kind: "hopeless-forecast-hold" },
      { kind: "market-evidence-floor", percentOfEstimate: 90 },
    ]);
    expect(
      validateRepricingDryRunBody({ ...dryRunBody, rules: command(directive()).rules }, "acc_synthetic").rules[0]!
        .directive.anchorChain,
    ).toEqual(state.rules[0]!.directive.anchorChain);
  });

  it.each([
    ["goal-unknown", { goalId: "unknown" }],
    ["goal-not-selectable", { goalVersion: 2 }],
    ["goal-not-selectable", { goalVersion: 0 }],
    ["goal-parameter-unknown", { parameters: { surprise: 1 } }],
    ["goal-parameter-out-of-bounds", { parameters: { percentile: 100 } }],
    ["goal-parameter-out-of-bounds", { parameters: { percentile: Number.NaN } }],
  ])("rejects %s before recording", (reason, overrides) => {
    const value = directive({ anchorChain: [{ ...goal, ...overrides }] });
    expect(() => decideRepricingPolicy(initialRepricingPolicyState, command(value))).toThrow(
      RepricingPolicyValidationError,
    );
    expect(() => decideRepricingPolicy(initialRepricingPolicyState, command(value))).toThrow(reason);
  });

  it.each([50, 100])("accepts the inclusive market-evidence-floor bound %s", (percentOfEstimate) => {
    expect(() =>
      decideRepricingPolicy(
        initialRepricingPolicyState,
        command(
          directive({
            guardrails: [{ kind: "market-evidence-floor", percentOfEstimate }],
          }),
        ),
      ),
    ).not.toThrow();
  });
  it.each([49, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid floor percentage %s",
    (percentOfEstimate) => {
      expect(() =>
        decideRepricingPolicy(
          initialRepricingPolicyState,
          command(
            directive({
              guardrails: [{ kind: "market-evidence-floor", percentOfEstimate }],
            }),
          ),
        ),
      ).toThrow("guardrail-parameter-out-of-bounds");
    },
  );
  it("rejects duplicate kinds and a hopeless hold without a curve objective, retaining the existing chain cap", () => {
    for (const guardrail of [
      { kind: "hopeless-forecast-hold" },
      { kind: "market-evidence-floor", percentOfEstimate: 90 },
    ] as const) {
      expect(() =>
        decideRepricingPolicy(
          initialRepricingPolicyState,
          command(
            directive({
              guardrails: [guardrail, guardrail],
            }),
          ),
        ),
      ).toThrow("guardrail-duplicate-kind");
    }
    expect(() =>
      decideRepricingPolicy(
        initialRepricingPolicyState,
        command(
          directive({
            anchorChain: [{ source: "market-estimate" }],
            guardrails: [{ kind: "hopeless-forecast-hold" }],
          }),
        ),
      ),
    ).toThrow("guardrail-requires-curve-objective");
    expect(() =>
      decideRepricingPolicy(
        initialRepricingPolicyState,
        command(
          directive({
            anchorChain: Array.from({ length: 6 }, () => goal),
          }),
        ),
      ),
    ).toThrow("anchor chain cannot exceed");
  });
});
