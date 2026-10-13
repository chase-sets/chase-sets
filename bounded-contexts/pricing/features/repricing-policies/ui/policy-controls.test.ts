import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { t } from "@chase-sets/localization";
import { hashRepricingDryRunBody, validateRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { policyControls } from "./policy-controls";
import { summarizeRepricingRule } from "./policy-copy";
import { compileRepricingPreset, openRepricingPreset, repricingPresets, type RepricingPreset } from "./presets";

describe("policy union coverage and preset round trips", () => {
  it("pins all four preset body bytes, normalized bytes and dry-run hashes", () => {
    const fingerprints = Object.keys(repricingPresets).map((preset) => {
      const body = compileRepricingPreset({
        preset: preset as RepricingPreset,
        name: "Synthetic",
        currencyCode: "CAD",
        floor: { mode: "absolute", amount: "4.00" },
        scope: { kind: "all-listings" },
        knob: repricingPresets[preset as RepricingPreset].defaultValue,
      });
      const validated = validateRepricingDryRunBody(body, "acc_synthetic");
      const opened = openRepricingPreset(body);
      for (const rule of validated.rules) expect(rule.directive).not.toHaveProperty("guardrails");
      expect(opened.body).toEqual(body);
      return {
        preset,
        bytes: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        normalized: createHash("sha256").update(JSON.stringify(validated)).digest("hex"),
        hash: hashRepricingDryRunBody(validated),
      };
    });
    expect(fingerprints).toMatchInlineSnapshot(`
      [
        {
          "bytes": "6bd9f24fa5b2204162b3302d8b19bf1ee97215d071ad97c230a6dde9d3c47643",
          "hash": "bdcdf399f36e44aa382f9be01bac9c23f1175833e8b86998453b44321c024e51",
          "normalized": "14804056c038289412cae67155ea33f1d5a894a81e3205419ad00f8f8ab2cb3c",
          "preset": "track-market",
        },
        {
          "bytes": "e41308a09715d1fc86367a42deff896ad23402abfd4f7f81840064ccb0bd6b16",
          "hash": "18bf479ab780e729f7400610f8360c1c44a8aea486faff0bea87f3e950b96a5e",
          "normalized": "981909b8a007411331976d91d8d6d51162ea1c7943b6a01da4518e3c972e50cc",
          "preset": "beat-lowest",
        },
        {
          "bytes": "95dbff843244c92f443bfabdb70f5d049baf0f2fbb90a1b29b342a91d85c1032",
          "hash": "79a2c5f7ee44872e299d798a4a540c670aefc29460e0db352b975473edd48e0f",
          "normalized": "de8072e09aaa3df67994ca803ae01d2cab8721aba71bf76506b0af3b36529541",
          "preset": "premium",
        },
        {
          "bytes": "7416bca259b822db68af445865d581973056421e0e20bfa4aefc6f210683f842",
          "hash": "ad4a19add565bf4ca419bbb8a31e48ead1b4556f6a910701d67d6ac15088c60b",
          "normalized": "e61e98dc3f1826e63ef212c0f4ab73087f0129705b9d441fa26d8ef128f4ed6f",
          "preset": "slow-stock",
        },
      ]
    `);
  });
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
      anchor: ["market-estimate", "lowest-competing-ask", "comp-percentile", "last-sold", "curve-objective"],
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
  it("maps the curve objective to the read-only goal summary and authorized copy", () => {
    expect(policyControls.anchor["curve-objective"]).toEqual({
      copyKey: "pricing.features.repricingPolicies.ui.editor.anchor.curveObjective",
      control: "goal-summary",
    });
    const prefix = "pricing.features.repricingPolicies.ui.";
    expect([
      t(`${prefix}editor.anchor.curveObjective`),
      t(`${prefix}policyBody.anchor.curveObjective`, { goal: "Synthetic" }),
      t(`${prefix}goal.fixedPercentile`, { percentile: 65 }),
      t(`${prefix}goal.targetHorizon`, { days: 30 }),
      t(`${prefix}goal.profitPerDay`),
    ]).toEqual([
      "Pricing goal",
      "Pricing goal: Synthetic",
      "Price at the 65th market percentile",
      "Sell steadily within 30 days",
      "Maximize profit per day",
    ]);
    const body = compileRepricingPreset({
      preset: "track-market",
      name: "Synthetic",
      currencyCode: "USD",
      floor: { mode: "absolute", amount: "4.00" },
      scope: { kind: "all-listings" },
      knob: 0,
    });
    const rule = body.rules[0]!;
    expect(
      summarizeRepricingRule(
        {
          ...rule,
          directive: {
            ...rule.directive,
            anchorChain: [
              {
                source: "curve-objective",
                goalId: "fixed-percentile",
                goalVersion: 1,
                parameters: { percentile: 65 },
              },
            ],
          },
        },
        0,
      ).items.find(({ key }) => key === "Anchor")?.value,
    ).toBe("Pricing goal: Price at the 65th market percentile");
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
