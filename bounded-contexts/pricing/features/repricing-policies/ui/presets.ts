import type { RepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import type { RepricingFloor, RepricingPolicyScope, RepricingRuleDirective } from "../domain/domain";

export const repricingPresets = {
  "track-market": {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.track",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.track",
    knob: "pricing.features.repricingPolicies.ui.editor.adjust",
    min: -25,
    max: 25,
    defaultValue: 0,
  },
  "beat-lowest": {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.beat",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.beat",
    knob: "pricing.features.repricingPolicies.ui.editor.undercut",
    min: 0,
    max: 15,
    defaultValue: 2,
  },
  premium: {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.premium",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.premium",
    knob: "pricing.features.repricingPolicies.ui.editor.premium",
    min: 0,
    max: 30,
    defaultValue: 5,
  },
  "slow-stock": {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.slow",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.slow",
    knob: "pricing.features.repricingPolicies.ui.editor.markdown",
    min: 0,
    max: 30,
    defaultValue: 10,
  },
} as const;
export type RepricingPreset = keyof typeof repricingPresets;
export type PolicyEditorBody = RepricingDryRunBody & Readonly<{ name: string }>;

export function compileRepricingPreset(
  input: Readonly<{
    preset: RepricingPreset;
    name: string;
    currencyCode: string;
    floor: RepricingFloor;
    knob: number;
    ageDays?: number;
    scope: RepricingPolicyScope;
  }>,
): PolicyEditorBody {
  const marketChain = [
    { source: "market-estimate" },
    { source: "lowest-competing-ask" },
    { source: "last-sold" },
  ] as const;
  const directive: RepricingRuleDirective = {
    currencyCode: input.currencyCode,
    anchorChain:
      input.preset === "beat-lowest"
        ? [{ source: "lowest-competing-ask" }, { source: "market-estimate" }]
        : input.preset === "premium"
          ? [{ source: "comp-percentile", percentile: 75 }, { source: "market-estimate" }]
          : marketChain,
    offset: {
      mode: "percent",
      percent: input.preset === "beat-lowest" || input.preset === "slow-stock" ? -input.knob : input.knob,
    },
    floor: input.floor,
    ceiling: null,
    tolerance: { mode: "percent", percent: input.preset === "beat-lowest" ? 1 : input.preset === "premium" ? 3 : 2 },
    rounding: { mode: "none" },
    maxMovePercent: input.preset === "premium" ? 15 : input.preset === "slow-stock" ? 25 : 20,
    terminal: { kind: "hold" },
  };
  return {
    name: input.name,
    scope: input.scope,
    excludedListingIds: [],
    maxChangesPerDay: 250,
    rules:
      input.preset === "slow-stock"
        ? [
            { conditions: [{ type: "listing-age-at-least", days: input.ageDays ?? 45 }], directive },
            {
              conditions: [],
              directive: {
                ...directive,
                offset: { mode: "percent", percent: 0 },
                tolerance: { mode: "percent", percent: 5 },
                maxMovePercent: 10,
              },
            },
          ]
        : [{ conditions: [], directive }],
  };
}

export function openRepricingPreset(body: PolicyEditorBody) {
  return { tier: body.rules.length === 1 ? ("structured" as const) : ("advanced" as const), body };
}
