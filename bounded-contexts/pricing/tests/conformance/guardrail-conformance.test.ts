import { describe, expect, it } from "vitest";
import { moneyToCents } from "@chase-sets/primitives/money";
import { evaluateRepricingListing } from "../../features/repricing-engine/domain/evaluate";
import {
  freshUntil,
  goalDirective,
  goalListing,
  goalSnapshot,
  parityCurve,
} from "../../features/repricing-engine/tests/curve-objective-fixture";
import {
  resolveRepricingGuardrail,
  type RepricingGuardrail,
  type RepricingRuleDirective,
} from "../../features/repricing-policies/domain/domain";
import {
  createGuardrailRegistry,
  type GuardrailContext,
  type GuardrailDefinition,
} from "../../features/repricing-policies/domain/guardrails/registry";
import { deepFreeze, describeConformance, runConformance, type ConformanceProperty } from "./kit";

type GuardrailScenario = Readonly<{
  parameters: Readonly<Record<string, number>>;
  /** Evidence under which the kind acts, and evidence under which it stays inert. */
  hit: GuardrailContext;
  miss: GuardrailContext;
  /** A listing whose directive carries the kind and meets its hit evidence; overrides edit that directive. */
  evaluation: (overrides: Partial<RepricingRuleDirective>) => Parameters<typeof evaluateRepricingListing>;
}>;

const context = (overrides: Partial<GuardrailContext>): GuardrailContext => ({
  currencyCode: "USD",
  sellerAccountId: "acc_goal",
  currentCents: 1_000n,
  targetCents: 500n,
  resolvedAnchorSource: "market-estimate",
  parameters: {},
  marketEstimate: { state: "absent" },
  otherSellerHardAsks: [],
  hardAskOutlierPriceRatio: 10,
  curve: { state: "absent" },
  ...overrides,
});

const hopelessCurve = (hopeless: boolean): GuardrailContext["curve"] => ({
  state: "present",
  currencyCode: "USD",
  points: [
    { amountCents: 500n, medianSellDays: 200, hopeless },
    { amountCents: 1_000n, medianSellDays: 400, hopeless: true },
  ],
});

/** Keyed by every authorable kind, so a new kind does not compile until it declares its scenario. */
const scenarios = {
  "market-evidence-floor": {
    parameters: { percentOfEstimate: 80 },
    hit: context({
      parameters: { percentOfEstimate: 80 },
      marketEstimate: { state: "present", currencyCode: "USD", amountCents: 1_000n },
    }),
    miss: context({
      parameters: { percentOfEstimate: 80 },
      targetCents: 900n,
      marketEstimate: { state: "present", currencyCode: "USD", amountCents: 1_000n },
    }),
    evaluation: (overrides) => [
      goalListing(
        goalDirective({
          anchorChain: [{ source: "market-estimate" }],
          offset: { mode: "percent", percent: -50 },
          guardrails: [{ kind: "market-evidence-floor", percentOfEstimate: 80 }],
          ...overrides,
        }),
      ),
      goalSnapshot({ demandCurve: null }),
    ],
  },
  "hopeless-forecast-hold": {
    parameters: {},
    hit: context({ resolvedAnchorSource: "curve-objective", curve: hopelessCurve(true) }),
    miss: context({ resolvedAnchorSource: "curve-objective", curve: hopelessCurve(false) }),
    evaluation: (overrides) => [
      goalListing(goalDirective({ guardrails: [{ kind: "hopeless-forecast-hold" }], ...overrides })),
      goalSnapshot({
        demandCurve: {
          ...parityCurve,
          freshUntil,
          points: parityCurve.points.map((point) => ({ ...point, hopeless: true })),
        },
      }),
    ],
  },
} satisfies Record<RepricingGuardrail["kind"], GuardrailScenario>;

function scenarioOf(definition: GuardrailDefinition): GuardrailScenario {
  const scenario: GuardrailScenario | undefined = scenarios[definition.kind];
  if (!scenario) throw new Error(`${definition.kind} declares no conformance scenario.`);
  return scenario;
}

const evaluateWith = (definition: GuardrailDefinition, overrides: Partial<RepricingRuleDirective> = {}) =>
  evaluateRepricingListing(...scenarioOf(definition).evaluation(overrides));

/** The guardrail contract (#9308, evaluated by #9309); checks read only the registered definition. */
const guardrailProperties: readonly ConformanceProperty<GuardrailDefinition>[] = [
  {
    name: "validates its authored parameters and rejects unknown ones",
    check: (definition) => {
      const { parameters } = scenarioOf(definition);
      expect(definition.validateParameters(parameters)).toEqual({ kind: "valid", parameters });
      expect(definition.validateParameters({ ...parameters, conformanceUnknown: 1 })).toEqual({
        kind: "rejected",
        reason: "guardrail-parameter-unknown",
      });
    },
  },
  {
    name: "applies purely over its GuardrailContext",
    check: (definition) => {
      const { hit, miss } = scenarioOf(definition);
      for (const evidence of [hit, miss]) {
        const frozen = deepFreeze(structuredClone(evidence));
        const outcome = definition.apply(frozen);
        expect(definition.apply(frozen)).toEqual(outcome);
        expect(definition.apply(structuredClone(evidence))).toEqual(outcome);
      }
    },
  },
  {
    name: "acts on its hit evidence, raises any clamped target, and stays inert otherwise",
    check: (definition) => {
      const { hit, miss } = scenarioOf(definition);
      const outcome = definition.apply(hit);
      expect(outcome.outcome).not.toBe("inert");
      if (outcome.outcome === "clamp") expect(outcome.amountCents > hit.targetCents).toBe(true);
      expect(definition.apply(miss)).toEqual({ outcome: "inert" });
    },
  },
  {
    name: "is idempotent: applying to its own result changes nothing",
    check: (definition) => {
      const { hit, miss } = scenarioOf(definition);
      const sweep = Array.from({ length: 21 }, (_, index) => ({ ...hit, targetCents: BigInt(index * 100) }));
      for (const evidence of [hit, miss, ...sweep]) {
        const outcome = definition.apply(evidence);
        const again = definition.apply(
          outcome.outcome === "clamp" ? { ...evidence, targetCents: outcome.amountCents } : evidence,
        );
        if (outcome.outcome === "clamp") expect(again).toEqual({ outcome: "inert" });
        else expect(again).toEqual(outcome);
      }
    },
  },
  {
    name: "records its hit in the listing evaluation",
    check: (definition) => {
      const outcome = definition.apply(scenarioOf(definition).hit);
      const evaluation = evaluateWith(definition);
      expect(evaluation).not.toEqual(evaluateWith(definition, { guardrails: undefined }));
      if (outcome.outcome === "hold")
        expect(evaluation).toMatchObject({ action: "hold", skipReason: outcome.reason, targetPriceAmount: null });
      else expect(evaluation.flags).toContain("evidence-floor-binding");
    },
  },
  {
    name: "never raises the price above the seller's ceiling",
    check: (definition) => {
      const unbounded = evaluateWith(definition);
      const ceiling = "1.50";
      const bounded = evaluateWith(definition, { ceiling: { mode: "absolute", amount: ceiling } });
      if (unbounded.targetPriceAmount === null) {
        expect(bounded.targetPriceAmount).toBeNull();
        return;
      }
      expect(moneyToCents(unbounded.targetPriceAmount) > moneyToCents(ceiling)).toBe(true);
      expect(bounded.targetPriceAmount).toBe(ceiling);
      expect(bounded.flags).toContain("ceiling-binding");
    },
  },
];

const registeredGuardrails = () =>
  (Object.keys(scenarios) as RepricingGuardrail["kind"][]).map((kind) => {
    const definition = resolveRepricingGuardrail(kind);
    if (!definition) throw new Error(`Authorable guardrail kind ${kind} is not registered.`);
    return definition;
  });

describeConformance({
  registry: createGuardrailRegistry,
  entries: registeredGuardrails,
  key: (definition) => `${definition.kind}@${definition.version}`,
  properties: guardrailProperties,
});

describe("guardrail conformance negative controls", () => {
  it("fails a kind that acts on every input and keeps raising its own result", async () => {
    const floor = resolveRepricingGuardrail("market-evidence-floor")!;
    const drifting: GuardrailDefinition = {
      ...floor,
      apply: (evidence) => ({ outcome: "clamp", amountCents: evidence.targetCents + 1n }),
    };
    const failures = await runConformance({
      registry: createGuardrailRegistry,
      entries: () => [drifting],
      key: (definition) => definition.kind,
      properties: guardrailProperties,
    });
    expect(failures.map(({ property }) => property)).toEqual(
      expect.arrayContaining([
        "acts on its hit evidence, raises any clamped target, and stays inert otherwise",
        "is idempotent: applying to its own result changes nothing",
      ]),
    );
  });
});
