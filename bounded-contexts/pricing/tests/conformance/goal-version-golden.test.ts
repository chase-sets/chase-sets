import { describe, expect, it } from "vitest";
import { resolvePricingGoal } from "../../features/repricing-policies/domain/domain";
import {
  createPricingGoalRegistry,
  type PricingGoalDefinition,
} from "../../features/repricing-policies/domain/goals/registry";
import { goalDeclarations } from "./goal-declarations";
import { goldenDecisionProperty, goalVersionKey, type GoalDeclarations } from "./goal-properties";
import { runConformance } from "./kit";

const incumbent = resolvePricingGoal("fixed-percentile", 1)!;

/** The same goal with its default moved from P65 to P70: a changed decision on the fixture curves. */
const changed: PricingGoalDefinition = {
  ...incumbent,
  parameterSchema: { percentile: { ...incumbent.parameterSchema.percentile!, default: 70 } },
};

/** The pinned app's recorded `percentile` 70 decisions, an expectation independent of the kit. */
const recordedP70 = (curve: "observed" | "truncated-supply") => ({
  kind: "decision",
  selectedPriceAmount: "9.50",
  unconstrainedPriceAmount: "9.50",
  equivalentPercentile: 70,
  forecast:
    curve === "observed"
      ? { medianSellDays: 37.42994775023705, status: "interpolated" }
      : { medianSellDays: null, status: "unavailable" },
  unprofitable: false,
  rationale: { parameters: { percentile: 70 }, dailyReturnHurdle: null, netProceeds: null },
});

const goldenFailures = (goals: readonly PricingGoalDefinition[], declarations: GoalDeclarations = goalDeclarations) =>
  runConformance({ registry: createPricingGoalRegistry, entries: () => goals, key: goalVersionKey, properties: [] }, [
    goldenDecisionProperty(declarations),
  ]);

describe("Goal Version is enforced by the Golden Decision", () => {
  it("passes an unchanged decision at the same version", async () => {
    const refactored: PricingGoalDefinition = { ...incumbent, solve: (input) => incumbent.solve(input) };
    expect(await goldenFailures([refactored])).toEqual([]);
  });

  it("fails a changed decision without a version bump", async () => {
    expect(await goldenFailures([changed])).toEqual([
      {
        entry: "fixed-percentile@1",
        property: "reproduces its Golden Decision on the shared fixture curves",
        message: expect.stringContaining(
          "fixed-percentile@1 changed its decision on the observed fixture curve; a changed decision is a new Goal Version",
        ),
      },
    ]);
  });

  it("fails the bumped version until it records its own Golden Decision", async () => {
    expect(await goldenFailures([{ ...changed, version: 2 }])).toEqual([
      {
        entry: "fixed-percentile@2",
        property: "reproduces its Golden Decision on the shared fixture curves",
        message: "fixed-percentile@2 has no declaration and Golden Decision in the kit.",
      },
    ]);
  });

  it("Step 8 — Give a changed decision a new version with its own Golden Decision", async () => {
    const declarations: GoalDeclarations = {
      ...goalDeclarations,
      "fixed-percentile@2": {
        priceScalesWithCurve: true,
        golden: { observed: recordedP70("observed"), "truncated-supply": recordedP70("truncated-supply") },
      },
    };
    expect(await goldenFailures([incumbent, { ...changed, version: 2 }], declarations)).toEqual([]);
  });
});
