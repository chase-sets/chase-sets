import { describe, expect, it } from "vitest";
import type { RepricingRule, RepricingRuleDirective } from "../../repricing-policies/domain/domain";
import {
  evaluateRepricingListing,
  type RepricingListingEvaluationInput,
  type RepricingMarketInputSnapshot,
} from "./evaluate";

const directive: RepricingRuleDirective = {
  anchorChain: [{ source: "lowest-competing-ask" }, { source: "market-estimate" }],
  offset: { mode: "absolute", amount: "-0.01" },
  floor: { mode: "absolute", amount: "5.00" },
  ceiling: null,
  tolerance: { mode: "absolute", amount: "0.25" },
  rounding: { mode: "none" },
  maxMovePercent: null,
  terminal: { kind: "hold" },
};

function listing(overrides: Partial<RepricingListingEvaluationInput> = {}): RepricingListingEvaluationInput {
  return {
    listingId: "lst_policy",
    sellerAccountId: "acc_policy",
    currentPriceAmount: "10.00",
    quantityCap: 2,
    categoryIds: ["cat_cards"],
    grading: "raw",
    createdAt: "2026-07-01T00:00:00.000Z",
    costBasisAmount: null,
    rules: [{ conditions: [], directive }],
    ...overrides,
  };
}

function snapshot(overrides: Partial<RepricingMarketInputSnapshot> = {}): RepricingMarketInputSnapshot {
  return {
    catalogItemId: "cat_1",
    productId: "cat_1::",
    capturedAt: "2026-07-17T12:00:00.000Z",
    marketEstimate: { amount: "12.00", freshUntil: "2026-07-18T00:00:00.000Z" },
    lastSoldAmount: "11.00",
    competingAsks: [
      { listingId: "lst_policy", sellerAccountId: "acc_policy", amount: "10.00", pricingMode: "derived" },
      { listingId: "lst_same_account", sellerAccountId: "acc_policy", amount: "8.00", pricingMode: "hard" },
      { listingId: "lst_derived", sellerAccountId: "acc_other", amount: "7.00", pricingMode: "derived" },
      { listingId: "lst_hard", sellerAccountId: "acc_other", amount: "11.00", pricingMode: "hard" },
    ],
    ...overrides,
  };
}

describe("repricing product-round evaluation", () => {
  it("anchors only on another account's hard ask and applies the directive offset", () => {
    const result = evaluateRepricingListing(listing(), snapshot());

    expect(result.anchor).toEqual({
      source: "lowest-competing-ask",
      amount: "11.00",
      stratum: "hard-ask",
      contributingListingCount: 1,
    });
    expect(result.targetPriceAmount).toBe("10.99");
    expect(result.action).toBe("update-price");
  });

  it("walks stale/absent anchors and falls back to the first present ground input", () => {
    const rules: readonly RepricingRule[] = [
      {
        conditions: [],
        directive: {
          ...directive,
          anchorChain: [{ source: "market-estimate" }, { source: "lowest-competing-ask" }, { source: "last-sold" }],
        },
      },
    ];
    const result = evaluateRepricingListing(
      listing({ rules }),
      snapshot({
        marketEstimate: { amount: "12.00", freshUntil: "2026-07-16T00:00:00.000Z" },
        competingAsks: [],
      }),
    );

    expect(result.exhaustedAnchors).toEqual([
      { source: "market-estimate", state: "stale" },
      { source: "lowest-competing-ask", state: "absent" },
    ]);
    expect(result.anchor?.source).toBe("last-sold");
    expect(result.targetPriceAmount).toBe("10.99");
  });

  it("suppresses a target inside the seller's absolute tolerance band", () => {
    const result = evaluateRepricingListing(
      listing(),
      snapshot({
        competingAsks: [{ listingId: "lst_hard", sellerAccountId: "acc_other", amount: "10.20", pricingMode: "hard" }],
      }),
    );

    expect(result.targetPriceAmount).toBe("10.19");
    expect(result.action).toBe("hold");
    expect(result.skipReason).toBe("within-tolerance");
  });

  it("rounds before clamps, keeps the floor hard, and reports every binding clamp", () => {
    const rules: readonly RepricingRule[] = [
      {
        conditions: [],
        directive: {
          ...directive,
          anchorChain: [{ source: "market-estimate" }],
          offset: { mode: "percent", percent: -50 },
          floor: { mode: "cost-basis-plus-margin", marginPercent: 25, absoluteFallbackAmount: "5.00" },
          ceiling: { mode: "absolute", amount: "15.00" },
          rounding: { mode: "charm" },
          maxMovePercent: 10,
        },
      },
    ];
    const result = evaluateRepricingListing(
      listing({ currentPriceAmount: "20.00", costBasisAmount: "12.00", rules }),
      snapshot({ marketEstimate: { amount: "20.00", freshUntil: "2026-07-18T00:00:00.000Z" } }),
    );

    expect(result.targetPriceAmount).toBe("18.00");
    expect(result.clamps.floor).toBe(true);
    expect(result.clamps.maxMove).toBe(true);
    expect(result.flags).toEqual(["floor-binding", "max-move-binding"]);
  });

  it("selects the first matching rule and evaluates fallback-price terminals through the same clamp/tolerance path", () => {
    const rules: readonly RepricingRule[] = [
      {
        conditions: [{ type: "quantity-at-least", quantity: 5 }],
        directive,
      },
      {
        conditions: [],
        directive: {
          ...directive,
          anchorChain: [{ source: "lowest-competing-ask" }],
          terminal: { kind: "fallback-price", amount: "8.00" },
        },
      },
    ];
    const result = evaluateRepricingListing(listing({ rules }), snapshot({ competingAsks: [] }));

    expect(result.ruleIndex).toBe(1);
    expect(result.anchor).toBeNull();
    expect(result.targetPriceAmount).toBe("7.99");
    expect(result.action).toBe("update-price");
  });

  it("uses nearest-rank comp percentiles", () => {
    const rules: readonly RepricingRule[] = [
      {
        conditions: [],
        directive: { ...directive, anchorChain: [{ source: "comp-percentile", percentile: 50 }] },
      },
    ];
    const result = evaluateRepricingListing(
      listing({ rules }),
      snapshot({
        competingAsks: ["9.00", "12.00", "20.00"].map((amount, index) => ({
          listingId: `lst_${index}`,
          sellerAccountId: `acc_${index}`,
          amount,
          pricingMode: "hard" as const,
        })),
      }),
    );

    expect(result.anchor?.amount).toBe("12.00");
    expect(result.targetPriceAmount).toBe("11.99");
  });

  it("filters a 1k-product signal scenario down to only beyond-tolerance writes", () => {
    const results = Array.from({ length: 1_000 }, (_, index) =>
      evaluateRepricingListing(
        listing({
          listingId: `lst_${index}`,
          currentPriceAmount: index % 10 === 0 ? "10.00" : "10.90",
        }),
        snapshot({ productId: `cat_1::${index}` }),
      ),
    );

    expect(results.filter((result) => result.action === "update-price")).toHaveLength(100);
    expect(results.filter((result) => result.skipReason === "within-tolerance")).toHaveLength(900);
  });
});
