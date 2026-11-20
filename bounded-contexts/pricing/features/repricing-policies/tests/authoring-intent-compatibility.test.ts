import { describe, expect, it } from "vitest";
import {
  bindGoalAuthoringIntent,
  recognizeAuthoringIntent,
  repricingEditorDefaults,
  repricingPresetControls,
} from "../domain/authoring-intent";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { validateRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { openRepricingPreset } from "../ui/presets";
import { resolvePricingGoal } from "../domain/domain";

describe("authoring intent compatibility", () => {
  it("offers each preset's knob, the slow-stock age, and starts from the account's one currency and its cost basis", () => {
    expect(repricingPresetControls()).toEqual([
      { preset: "track-market", knob: { min: -25, max: 25, defaultValue: 0 }, ageDays: null },
      { preset: "beat-lowest", knob: { min: 0, max: 15, defaultValue: 2 }, ageDays: null },
      { preset: "premium", knob: { min: 0, max: 30, defaultValue: 5 }, ageDays: null },
      { preset: "slow-stock", knob: { min: 0, max: 30, defaultValue: 10 }, ageDays: { min: 14, max: 180, defaultValue: 45 } },
    ]);
    expect(repricingEditorDefaults({ listingCurrencyCodes: ["CAD"], hasCostBasis: true })).toEqual({
      currencyCode: "CAD",
      floor: { mode: "cost-basis-plus-margin", marginPercent: 10 },
    });
    expect(repricingEditorDefaults({ listingCurrencyCodes: ["CAD", "USD"], hasCostBasis: false })).toEqual({
      currencyCode: null,
      floor: { mode: "absolute" },
    });
    expect(repricingEditorDefaults({ listingCurrencyCodes: [], hasCostBasis: false }).currencyCode).toBeNull();
  });
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
