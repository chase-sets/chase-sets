import { describe, expect, it } from "vitest";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { compilePresetBody, recognizeAuthoringIntent } from "../domain/authoring-intent";
import { decideRepricingPolicy, evolveRepricingPolicy, initialRepricingPolicyState } from "../domain/domain";
import { hashRepricingDryRunBody, validateRepricingDryRunBody } from "../../repricing-engine/api/dry-run";

const slowStock = () =>
  compilePresetBody({
    preset: "slow-stock",
    name: "Slow stock",
    currencyCode: "USD",
    floor: { mode: "absolute", amount: "4.00" },
    knob: 12,
    ageDays: 60,
    scope: { kind: "all-listings" },
  });

describe("versioned preset intent round trip", () => {
  it.each(["track-market", "slow-stock"] as const)(
    "retains %s controls and complete rules through preview, create, replay and revision",
    (preset) => {
      const compiled = compilePresetBody({
        ...slowStock().authoringIntent.source,
        preset,
        name: "Original",
        currencyCode: "USD",
        floor: { mode: "absolute", amount: "4.00" },
        knob: 12,
        scope: { kind: "all-listings" },
      });
      const preview = validateRepricingDryRunBody(compiled, "acc_7910");
      const events = decideRepricingPolicy(initialRepricingPolicyState, {
        ...preview,
        name: compiled.name,
        type: "CreateRepricingPolicy",
        policyId: parseTypedId("rpp_8340", "rpp"),
        accountId: parseTypedId("acc_7910", "acc"),
        createdAt: "2026-10-28T00:00:00Z",
      });
      const saved = JSON.parse(JSON.stringify(events)).reduce(evolveRepricingPolicy, initialRepricingPolicyState);
      expect(saved.rules).toEqual(compiled.rules);
      expect(saved.authoringIntent).toEqual(compiled.authoringIntent);
      const revised = decideRepricingPolicy(saved, {
        ...compiled,
        name: "Renamed",
        type: "ReviseRepricingPolicy",
        revisedAt: "2026-10-28T00:01:00Z",
      }).reduce(evolveRepricingPolicy, saved);
      expect(revised.authoringIntent).toEqual(compiled.authoringIntent);
      expect(revised.rules).toEqual(compiled.rules);
      expect(hashRepricingDryRunBody({ ...compiled, authoringIntent: null })).toBe(hashRepricingDryRunBody(compiled));
    },
  );

  it("invalidates a changed trailing default, preserves the edit on replay, and refuses forged attribution", () => {
    const original = slowStock();
    const changed = {
      ...original,
      rules: original.rules.map((rule, index) =>
        index === 1
          ? { ...rule, directive: { ...rule.directive, offset: { mode: "percent" as const, percent: -7 } } }
          : rule,
      ),
    };
    expect(recognizeAuthoringIntent(changed)).toBeNull();
    const preview = validateRepricingDryRunBody(changed, "acc_7910");
    expect(preview.authoringIntent).toBeUndefined();
    expect(preview.rules[1]!.directive.offset).toEqual({ mode: "percent", percent: -7 });
    const forged = {
      ...changed,
      authoringIntent: {
        ...original.authoringIntent,
        semanticBody: original.authoringIntent.semanticBody.replace('"percent":0', '"percent":-7'),
      },
    };
    expect(recognizeAuthoringIntent(forged)).toBeNull();
    const state = decideRepricingPolicy(initialRepricingPolicyState, {
      ...original,
      type: "CreateRepricingPolicy",
      policyId: parseTypedId("rpp_8340", "rpp"),
      accountId: parseTypedId("acc_7910", "acc"),
      createdAt: "2026-10-28T00:00:00Z",
    }).reduce(evolveRepricingPolicy, initialRepricingPolicyState);
    const saved = decideRepricingPolicy(state, {
      ...changed,
      type: "ReviseRepricingPolicy",
      revisedAt: "2026-10-28T00:01:00Z",
    }).reduce(evolveRepricingPolicy, state);
    expect(JSON.parse(JSON.stringify(saved)).authoringIntent).toBeNull();
    expect(saved.rules).toEqual(preview.rules);
  });

  it("rejects an unknown compiler version without modifying the rules", () => {
    const original = slowStock();
    const unknown = { ...original, authoringIntent: { ...original.authoringIntent, compilerVersion: 2 as 1 } };
    expect(recognizeAuthoringIntent(unknown)).toBeNull();
    expect(validateRepricingDryRunBody(unknown, "acc_7910").rules).toEqual(original.rules);
  });
});
