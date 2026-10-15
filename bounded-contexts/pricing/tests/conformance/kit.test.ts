import { describe, expect, it } from "vitest";
import { resolvePricingGoal } from "../../features/repricing-policies/domain/domain";
import {
  createPricingGoalRegistry,
  type GoalDecision,
  type PricingGoalDefinition,
} from "../../features/repricing-policies/domain/goals/registry";
import { goalDeclarations } from "./goal-declarations";
import { goalConformanceProperties, goalVersionKey } from "./goal-properties";
import { runConformance } from "./kit";

const incumbent = resolvePricingGoal("fixed-percentile", 1)!;
const properties = goalConformanceProperties(goalDeclarations);

const failedProperties = async (goal: PricingGoalDefinition) =>
  (
    await runConformance({
      registry: createPricingGoalRegistry,
      entries: () => [goal],
      key: goalVersionKey,
      properties,
    })
  ).map(({ property }) => property);

describe("Conformance Kit negative controls", () => {
  it("fails an empty registry instead of passing it", async () => {
    expect(
      await runConformance({
        registry: createPricingGoalRegistry,
        entries: () => createPricingGoalRegistry().definitions(),
        key: goalVersionKey,
        properties,
      }),
    ).toEqual([
      { entry: null, property: "registered-entries", message: "No registered entries; an empty run proves nothing." },
    ]);
  });

  it("fails repeated entry keys", async () => {
    expect(
      await runConformance({
        registry: createPricingGoalRegistry,
        entries: () => [incumbent, incumbent],
        key: goalVersionKey,
        properties,
      }),
    ).toEqual([{ entry: null, property: "registered-entries", message: "Repeated entry keys: fixed-percentile@1." }]);
  });

  it("passes the registered goal it starts from", async () => {
    expect(await failedProperties(incumbent)).toEqual([]);
  });

  it("fails a goal that decides differently on the same captured inputs", async () => {
    let calls = 0;
    const drifting: PricingGoalDefinition = {
      ...incumbent,
      solve: (input) => {
        const result = incumbent.solve(input);
        calls += 1;
        return result.kind === "decision" && calls % 2 === 0
          ? { ...result, equivalentPercentile: result.equivalentPercentile + 1 }
          : result;
      },
    };
    expect(await failedProperties(drifting)).toContain("decides deterministically over frozen captured inputs");
  });

  it("fails a goal that writes to its captured inputs", async () => {
    const mutating: PricingGoalDefinition = {
      ...incumbent,
      solve: (input) => {
        (input.parameters as Record<string, number>).percentile = 50;
        return incumbent.solve(input);
      },
    };
    expect(await failedProperties(mutating)).toContain("decides deterministically over frozen captured inputs");
  });

  it("fails a goal whose price falls when it claims to scale with the curve", async () => {
    const inverted: PricingGoalDefinition = {
      ...incumbent,
      solve: (input) =>
        incumbent.solve({
          ...input,
          curve: {
            ...input.curve,
            points: input.curve.points.map((point) => ({
              ...point,
              priceAmount: (100 / Number(point.priceAmount)).toFixed(2),
            })),
          },
        }),
    };
    expect(await failedProperties(inverted)).toContain("responds monotonically to curve prices where it claims to");
  });

  it("fails a goal whose explanation names another Goal Version", async () => {
    const misattributed: PricingGoalDefinition = {
      ...incumbent,
      explain: (decision: GoalDecision) => ({ ...incumbent.explain(decision), goalVersion: 2 }),
    };
    expect(await failedProperties(misattributed)).toContain("explains every decision with its own identity and values");
  });

  it("fails a goal that ignores a curve feature it declares as required", async () => {
    const undeclared: PricingGoalDefinition = { ...incumbent, requiredCurveFeatures: ["storeWinShare"] };
    expect(await failedProperties(undeclared)).toContain(
      "answers a stable unavailable result for each missing input it declares",
    );
  });
});
