import type { RepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { compilePresetBody, recognizeAuthoringIntent } from "../domain/authoring-intent";
export type { RepricingPreset } from "../domain/authoring-intent";

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
