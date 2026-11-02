import { describe, expect, it } from "vitest";
import { bindGoalAuthoringIntent, recognizeAuthoringIntent } from "../domain/authoring-intent";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { validateRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { openRepricingPreset } from "../ui/presets";
import { resolvePricingGoal } from "../domain/domain";

describe("authoring intent compatibility", () => {
  it("keeps legacy and custom policies editable without inferring a preset or goal", () => {
    const legacy = { ...dryRunBody, name: "Legacy" };
    expect(recognizeAuthoringIntent(legacy)).toBeNull();
    expect(openRepricingPreset(legacy).tier).toBe("structured");
    const edited = { ...legacy, maxChangesPerDay: 17 };
    expect(validateRepricingDryRunBody(edited, "acc_7910").maxChangesPerDay).toBe(17);
    expect(recognizeAuthoringIntent(edited)).toBeNull();
  });

  it("retains a registered selectable goal with its filled defaults through preview and reload", () => {
    const goal = bindGoalAuthoringIntent(
      {
        ...dryRunBody,
        name: "Goal",
        rules: [
          {
            ...dryRunBody.rules[0]!,
            directive: {
              ...dryRunBody.rules[0]!.directive,
              anchorChain: [
                {
                  source: "curve-objective" as const,
                  goalId: "fixed-percentile",
                  goalVersion: 1,
                  parameters: { percentile: 50 },
                },
              ],
            },
          },
        ],
      },
      resolvePricingGoal,
    );
    expect(recognizeAuthoringIntent(goal)?.source.kind).toBe("goal");
    const preview = validateRepricingDryRunBody(goal, "acc_7910");
    expect(openRepricingPreset({ ...JSON.parse(JSON.stringify(preview)), name: "Goal" }).tier).toBe("goal");
    expect(preview.rules).toEqual(goal.rules);
  });

  it("does not recognize or author unsupported goal versions and never changes the live body", () => {
    const unsupported = {
      ...dryRunBody,
      name: "Unsupported",
      rules: [
        {
          ...dryRunBody.rules[0]!,
          directive: {
            ...dryRunBody.rules[0]!.directive,
            anchorChain: [
              {
                source: "curve-objective" as const,
                goalId: "fixed-percentile",
                goalVersion: 999,
                parameters: { percentile: 50 },
              },
            ],
          },
        },
      ],
    };
    const before = JSON.stringify(unsupported);
    expect(
      recognizeAuthoringIntent(bindGoalAuthoringIntent(unsupported, resolvePricingGoal), resolvePricingGoal),
    ).toBeNull();
    expect(() => validateRepricingDryRunBody(unsupported, "acc_7910")).toThrow("goal-not-selectable");
    expect(JSON.stringify(unsupported)).toBe(before);
  });
});
