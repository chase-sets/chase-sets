import type { RepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import {
  compilePresetBody,
  recognizeAuthoringIntent,
  repricingPresetKnobs,
  type RepricingPreset,
} from "../domain/authoring-intent";
export type { RepricingPreset } from "../domain/authoring-intent";

const words = {
  "track-market": {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.track",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.track",
    knob: "pricing.features.repricingPolicies.ui.editor.adjust",
  },
  "beat-lowest": {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.beat",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.beat",
    knob: "pricing.features.repricingPolicies.ui.editor.undercut",
  },
  premium: {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.premium",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.premium",
    knob: "pricing.features.repricingPolicies.ui.editor.premium",
  },
  "slow-stock": {
    titleKey: "pricing.features.repricingPolicies.ui.editor.preset.slow",
    promise: "pricing.features.repricingPolicies.ui.editor.promise.slow",
    knob: "pricing.features.repricingPolicies.ui.editor.markdown",
  },
} as const satisfies Record<RepricingPreset, unknown>;

// Each preset's words; its knob's range and default are Pricing's (`repricingPresetKnobs`).
export const repricingPresets = {
  "track-market": { ...words["track-market"], ...repricingPresetKnobs["track-market"] },
  "beat-lowest": { ...words["beat-lowest"], ...repricingPresetKnobs["beat-lowest"] },
  premium: { ...words.premium, ...repricingPresetKnobs.premium },
  "slow-stock": { ...words["slow-stock"], ...repricingPresetKnobs["slow-stock"] },
} as const;
export type PolicyEditorBody = RepricingDryRunBody & Readonly<{ name: string }>;

export const compileRepricingPreset = compilePresetBody;

export function openRepricingPreset(body: PolicyEditorBody) {
  const intent = recognizeAuthoringIntent(body);
  return {
    tier: intent
      ? intent.source.kind === "preset"
        ? ("preset" as const)
        : ("goal" as const)
      : body.rules.length === 1
        ? ("structured" as const)
        : ("advanced" as const),
    body,
  };
}
