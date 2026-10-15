import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { validateRepricingDryRunBody } from "../../features/repricing-engine/api/dry-run";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../../features/repricing-engine/domain/policy";
import {
  planRepricingRound,
  planRepricingShadows,
  traceFromEvaluation,
} from "../../features/repricing-engine/domain/round";
import type { RepricingRoundInputs } from "../../features/repricing-engine/read-model/queries";
import {
  capturedAt,
  freshUntil,
  goalDirective,
  parityCurve,
} from "../../features/repricing-engine/tests/curve-objective-fixture";
import { dryRunBody } from "../../features/repricing-engine/tests/dry-run-fixture";
import {
  decideRepricingPolicy,
  initialRepricingPolicyState,
  pricingGoalDefinitions,
  resolvePricingGoal,
  type RepricingRule,
} from "../../features/repricing-policies/domain/domain";
import {
  createPricingGoalRegistry,
  type PricingGoalDefinition,
} from "../../features/repricing-policies/domain/goals/registry";
import { defineFixtureFlatOffsetGoal, fixtureFlatOffsetDeclaration, fixtureFlatOffsetGoal } from "./fixture-flat-offset";
import { goalDeclarations } from "./goal-declarations";
import { goalConformanceProperties, goalVersionKey } from "./goal-properties";
import { runConformance } from "./kit";

// The guide's registration step adds the goal to the list `domain.ts` passes to
// `createPricingGoalRegistry`, which registers each entry through
// `registerPricingGoal`. This test keeps production untouched: it records the
// registry `domain.ts` builds and registers the fixture through that same port.
const created = vi.hoisted(() => ({ registries: [] as unknown[] }));
vi.mock("../../features/repricing-policies/domain/goals/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../features/repricing-policies/domain/goals/registry")>();
  return {
    ...actual,
    createPricingGoalRegistry: (...args: Parameters<typeof actual.createPricingGoalRegistry>) => {
      const registry = actual.createPricingGoalRegistry(...args);
      created.registries.push(registry);
      return registry;
    },
  };
});

const productionGoalRegistry = () => created.registries[0] as ReturnType<typeof createPricingGoalRegistry>;
const fixtureKey = goalVersionKey(fixtureFlatOffsetGoal);
const productionKeys = pricingGoalDefinitions().map(goalVersionKey);

const anchoredRule = (goalVersion: number, parameters: Readonly<Record<string, number>> = {}): RepricingRule => ({
  conditions: [],
  directive: goalDirective({
    anchorChain: [{ source: "curve-objective", goalId: fixtureFlatOffsetGoal.id, goalVersion, parameters }],
  }),
});

const authoringCommand = (rules: readonly RepricingRule[]) => ({
  type: "CreateRepricingPolicy" as const,
  policyId: "rpp_fixture" as never,
  accountId: "acc_fixture" as never,
  name: "Fixture goal policy",
  scope: { kind: "all-listings" as const },
  rules,
  maxChangesPerDay: 10,
  createdAt: capturedAt,
});

/** Authors through the policy aggregate, so preview reads the rules exactly as they are recorded. */
function authoredRules(rules: readonly RepricingRule[]): readonly RepricingRule[] {
  const [event] = decideRepricingPolicy(initialRepricingPolicyState, authoringCommand(rules));
  if (event?.type !== "pricing.repricing-policy.created") throw new Error("Expected a created policy.");
  return event.data.rules;
}

function round(rules: readonly RepricingRule[]): RepricingRoundInputs {
  return {
    listings: [
      {
        listingId: "lst_fixture",
        sellerAccountId: "acc_fixture",
        inventoryItemId: null,
        catalogItemId: "cat_goal",
        productId: "cat_goal::",
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingVersion: 1,
        listingStatus: "active",
        pauseReason: null,
        categoryIds: [],
        grading: "raw",
        createdAt: "2026-07-01T00:00:00.000Z",
        costBasisAmount: null,
        costBasisCurrencyCode: null,
        policyId: "rpp_fixture",
        policyRevision: "1",
        rules,
        maxChangesPerDay: 10,
        economics: null,
      },
    ],
    competingAsks: [],
    marketEstimate: { amount: "10.00", currencyCode: "USD", freshUntil },
    lastSold: null,
    demandCurve: {
      catalogItemId: "cat_goal",
      productId: "cat_goal::",
      version: parityCurve.version,
      providerCondition: "Near Mint",
      providerVariant: "Normal",
      providerLanguage: "English",
      fingerprint: "sha256:fixture-curve",
      modelVersion: "fixture",
      policyRevisionId: "fallback",
      ladderMethod: "observed",
      anchorCondition: null,
      exposureStartReason: "fixture",
      salesCoverage: "complete",
      supplyStatus: "observed",
      ownSellerExclusionApplied: null,
      builtAt: capturedAt,
      currencyCode: parityCurve.currencyCode,
      freshUntil,
      points: parityCurve.points.map((point) => ({ ...point, salesCoverage: "complete" })),
    },
  };
}

const preview = (rules: readonly RepricingRule[]) =>
  planRepricingRound(round(rules), capturedAt, REPRICING_ENGINE_LAUNCH_POLICY_VALUE);

describe("a goal added by the authoring guide, with no engine or surface edit", () => {
  beforeAll(() => {
    expect(created.registries).toHaveLength(1);
    expect(productionGoalRegistry().definitions().map(goalVersionKey)).toEqual(productionKeys);
    expect(productionKeys).not.toContain(fixtureKey);
    productionGoalRegistry().registerPricingGoal(fixtureFlatOffsetGoal);
  });

  it("Step 1 — Write the goal as one module with definePricingGoal", () => {
    expect(fixtureFlatOffsetGoal).toMatchObject({
      id: "fixture-flat-offset",
      version: 1,
      lifecycle: "selectable",
      requiredCurveFeatures: [],
      requiresEconomics: false,
    });
  });

  it("Step 2 — Register it in the Pricing Goal registry", () => {
    expect(pricingGoalDefinitions().map(goalVersionKey)).toEqual([...productionKeys, fixtureKey].sort());
    expect(resolvePricingGoal(fixtureFlatOffsetGoal.id, 1)).toBe(fixtureFlatOffsetGoal);
  });

  it("Step 3 — Declare its curve claims and Golden Decision, and pass the Conformance Kit", async () => {
    const declarations = { ...goalDeclarations, [fixtureKey]: fixtureFlatOffsetDeclaration };
    const failures = await runConformance({
      registry: createPricingGoalRegistry,
      entries: () => pricingGoalDefinitions(),
      key: goalVersionKey,
      properties: goalConformanceProperties(declarations),
    });
    expect(failures).toEqual([]);
  });

  it("Step 4 — Authoring and dry runs validate it as a curve-objective anchor", () => {
    expect(authoredRules([anchoredRule(1)])[0]!.directive.anchorChain).toEqual([
      { source: "curve-objective", goalId: fixtureFlatOffsetGoal.id, goalVersion: 1, parameters: { offsetPercentiles: 10 } },
    ]);
    expect(() => authoredRules([anchoredRule(1, { offsetPercentiles: 41 })])).toThrow(
      "goal-parameter-out-of-bounds: offsetPercentiles",
    );
    expect(() => authoredRules([anchoredRule(1, { spread: 1 })])).toThrow("goal-parameter-unknown: spread");
    expect(() =>
      validateRepricingDryRunBody({ ...dryRunBody, rules: [anchoredRule(1)] }, "acc_fixture"),
    ).not.toThrow();
  });

  it("Step 5 — Preview prices listings with it", () => {
    const [evaluation] = preview(authoredRules([anchoredRule(1)]));
    expect(evaluation).toMatchObject({
      targetPriceAmount: "7.99",
      action: "update-price",
      anchor: {
        source: "curve-objective",
        goal: { goalId: fixtureFlatOffsetGoal.id, goalVersion: 1, equivalentPercentile: 60 },
      },
    });
  });

  it("Step 6 — The evaluated listing trace records its Goal Version", () => {
    const [evaluation] = preview(authoredRules([anchoredRule(1)]));
    expect(traceFromEvaluation(evaluation!, "changed", null)).toMatchObject({
      targetPriceAmount: "7.99",
      anchor: { goal: { goalId: fixtureFlatOffsetGoal.id, goalVersion: 1, curveVersion: parityCurve.version } },
    });
  });

  it("Step 7 — Ship a changed decision as a new version that runs in shadow first", () => {
    const rules = authoredRules([anchoredRule(1)]);
    const incumbent = JSON.stringify(preview(rules));
    const version2: PricingGoalDefinition = defineFixtureFlatOffsetGoal(2, 55);
    expect(version2.lifecycle).toBe("shadow");
    productionGoalRegistry().registerPricingGoal(version2);

    expect(() => authoredRules([anchoredRule(2)])).toThrow("goal-not-selectable");
    expect(JSON.stringify(preview(rules))).toBe(incumbent);
    expect(planRepricingShadows(round(rules), capturedAt, REPRICING_ENGINE_LAUNCH_POLICY_VALUE).get("lst_fixture")).toEqual([
      expect.objectContaining({
        goalId: fixtureFlatOffsetGoal.id,
        goalVersion: 2,
        anchorIndex: 0,
        targetPriceAmount: "8.75",
        skipped: null,
      }),
    ]);
  });
});

describe("the authoring guide", () => {
  const guideUrl = new URL("../../docs/pricing-goal-authoring.md", import.meta.url);

  it("links every step to the test that proves it, and every step here to the guide", () => {
    const guide = readFileSync(guideUrl, "utf8");
    const steps = [...guide.matchAll(/^### (Step \d+ — .+)$/gm)].map(([, title]) => title!);
    const proofs = [...guide.matchAll(/^Proof: \[([^\]]+)\]\(([^)]+)\)$/gm)].map(([, title, link]) => ({
      title: title!,
      link: link!,
    }));
    expect(steps.length).toBeGreaterThan(0);
    expect(proofs.map(({ title }) => title)).toEqual(steps);
    for (const { title, link } of proofs)
      expect(readFileSync(new URL(link, guideUrl), "utf8"), `${link} proves ${title}`).toContain(`it("${title}"`);
    const ownSteps = [...readFileSync(new URL(import.meta.url), "utf8").matchAll(/\bit\("(Step \d+ — [^"]+)"/g)].map(
      ([, title]) => title!,
    );
    expect(ownSteps.filter((title) => !steps.includes(title))).toEqual([]);
  });
});
