import { describe, expect, it } from "vitest";
import { t } from "@chase-sets/localization";
import { validateRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { policyControls } from "./policy-controls";
import { compileRepricingPreset, openRepricingPreset, repricingPresets, type RepricingPreset } from "./presets";

describe("policy union coverage and preset round trips", () => {
  it("maps every union variant to a named control and a real copy key", () => {
    const variants = {
      scope: ["all-listings", "catalog-filter", "listing-set"],
      condition: [
        "category",
        "item-grading",
        "quantity-at-least",
        "listing-age-at-least",
        "cost-basis-present",
        "cost-basis-absent",
        "competing-listing-count-at-least",
        "schedule-window",
      ],
      anchor: ["market-estimate", "lowest-competing-ask", "comp-percentile", "last-sold"],
      offset: ["percent", "absolute"],
      floor: ["absolute", "cost-basis-plus-margin"],
      ceiling: ["none", "percent", "absolute"],
      tolerance: ["percent", "absolute"],
      rounding: ["none", "charm", "increment"],
      terminal: ["hold", "pause", "fallback-price", "price-at-floor", "notify-only"],
    };
    for (const [group, expected] of Object.entries(variants)) {
      const options = policyControls[group as keyof typeof policyControls];
      expect(Object.keys(options)).toEqual(expected);
      for (const option of Object.values(options)) {
        expect(option.control.length).toBeGreaterThan(0);
        expect(t(option.copyKey)).not.toBe(option.copyKey);
      }
    }
  });
  it.each(Object.keys(repricingPresets) as RepricingPreset[])(
    "compiles %s with the complete approved defaults and opens losslessly",
    (preset) => {
      const config = repricingPresets[preset];
      const floor = { mode: "cost-basis-plus-margin" as const, marginPercent: 10, absoluteFallbackAmount: "4.00" };
      const body = compileRepricingPreset({
        preset,
        name: t(config.titleKey),
        currencyCode: "CAD",
        floor,
        knob: config.defaultValue,
        scope: { kind: "all-listings" },
      });
      expect(validateRepricingDryRunBody(body, "acc_synthetic")).toEqual({
        scope: body.scope,
        excludedListingIds: [],
        rules: body.rules,
        maxChangesPerDay: 250,
      });
      const expected = {
        "track-market": {
          sources: ["market-estimate", "lowest-competing-ask", "last-sold"],
          offset: 0,
          tolerance: 2,
          maxMove: 20,
        },
        "beat-lowest": { sources: ["lowest-competing-ask", "market-estimate"], offset: -2, tolerance: 1, maxMove: 20 },
        premium: { sources: ["comp-percentile", "market-estimate"], offset: 5, tolerance: 3, maxMove: 15 },
        "slow-stock": {
          sources: ["market-estimate", "lowest-competing-ask", "last-sold"],
          offset: -10,
          tolerance: 2,
          maxMove: 25,
        },
      }[preset];
      expect(body.rules[0]!.directive).toEqual({
        currencyCode: "CAD",
        anchorChain: expected.sources.map((source) =>
          source === "comp-percentile" ? { source, percentile: 75 } : { source },
        ),
        offset: { mode: "percent", percent: expected.offset },
        floor,
        ceiling: null,
        tolerance: { mode: "percent", percent: expected.tolerance },
        rounding: { mode: "none" },
        maxMovePercent: expected.maxMove,
        terminal: { kind: "hold" },
      });
      if (preset === "slow-stock") {
        expect(body.rules).toHaveLength(2);
        expect(body.rules[0]!.conditions).toEqual([{ type: "listing-age-at-least", days: 45 }]);
        expect(body.rules[1]).toEqual({
          conditions: [],
          directive: {
            ...body.rules[0]!.directive,
            offset: { mode: "percent", percent: 0 },
            tolerance: { mode: "percent", percent: 5 },
            maxMovePercent: 10,
          },
        });
      } else expect(body.rules).toEqual([{ conditions: [], directive: body.rules[0]!.directive }]);
      const opened = openRepricingPreset(body);
      expect(opened.tier).toBe(preset === "slow-stock" ? "advanced" : "structured");
      expect(opened.body).toEqual(body);
      expect(openRepricingPreset({ ...body, name: "Seller edit", maxChangesPerDay: 17 }).body).toEqual({
        ...body,
        name: "Seller edit",
        maxChangesPerDay: 17,
      });
    },
  );
  it("preserves currency, explicit floors, selected scope and the ruled knob ranges without supplying amounts", () => {
    expect(Object.values(repricingPresets).map(({ min, max, defaultValue }) => [min, max, defaultValue])).toEqual([
      [-25, 25, 0],
      [0, 15, 2],
      [0, 30, 5],
      [0, 30, 10],
    ]);
    const body = compileRepricingPreset({
      preset: "slow-stock",
      name: "Seller",
      currencyCode: "",
      floor: { mode: "absolute", amount: "" },
      knob: 30,
      ageDays: 180,
      scope: { kind: "listing-set", listingIds: ["lst_a"] },
    });
    expect(
      body.rules.every(
        (rule) =>
          rule.directive.currencyCode === "" &&
          rule.directive.floor.mode === "absolute" &&
          rule.directive.floor.amount === "",
      ),
    ).toBe(true);
    expect(body.rules[0]!.conditions).toEqual([{ type: "listing-age-at-least", days: 180 }]);
    expect(t(repricingPresets["beat-lowest"].promise)).toContain("market estimate instead");
  });
});
