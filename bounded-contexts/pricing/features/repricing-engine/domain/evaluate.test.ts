import { describe, expect, it } from "vitest";
import type { RepricingAnchor, RepricingRule, RepricingRuleDirective } from "../../repricing-policies/domain/domain";
import {
  evaluateRepricingListing,
  type RepricingListingEvaluationInput,
  type RepricingMarketInputSnapshot,
} from "./evaluate";

const directive: RepricingRuleDirective = {
  currencyCode: "USD",
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
    currentPriceCurrencyCode: "USD",
    currentPriceSourceVersion: 1,
    quantityCap: 2,
    categoryIds: ["cat_cards"],
    grading: "raw",
    createdAt: "2026-07-01T00:00:00.000Z",
    costBasisAmount: null,
    costBasisCurrencyCode: null,
    rules: [{ conditions: [], directive }],
    ...overrides,
  };
}

function snapshot(overrides: Partial<RepricingMarketInputSnapshot> = {}): RepricingMarketInputSnapshot {
  return {
    catalogItemId: "cat_1",
    productId: "cat_1::",
    capturedAt: "2026-07-17T12:00:00.000Z",
    hardAskOutlierPriceRatio: 10,
    marketEstimate: { amount: "12.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" },
    lastSold: { amount: "11.00", currencyCode: "USD", freshUntil: "2026-08-01T00:00:00.000Z" },
    competingAsks: [
      {
        listingId: "lst_policy",
        sellerAccountId: "acc_policy",
        amount: "10.00",
        currencyCode: "USD",
        pricingMode: "derived",
      },
      {
        listingId: "lst_same_account",
        sellerAccountId: "acc_policy",
        amount: "8.00",
        currencyCode: "USD",
        pricingMode: "hard",
      },
      {
        listingId: "lst_derived",
        sellerAccountId: "acc_other",
        amount: "7.00",
        currencyCode: "USD",
        pricingMode: "derived",
      },
      {
        listingId: "lst_hard",
        sellerAccountId: "acc_other",
        amount: "11.00",
        currencyCode: "USD",
        pricingMode: "hard",
      },
    ],
    ...overrides,
  };
}

describe("any-ask band", () => {
  const anyAnchor: RepricingAnchor = {
    source: "lowest-competing-ask",
    strata: "any",
    band: { ground: "market-estimate", minPercentOfGround: 90 },
  };
  const ground = { amount: "9.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" };
  const asks: RepricingMarketInputSnapshot["competingAsks"] = [
    {
      listingId: "lst_competing_hard",
      sellerAccountId: "acc_other",
      amount: "10.00",
      currencyCode: "USD",
      pricingMode: "hard",
    },
    {
      listingId: "lst_competing_derived",
      sellerAccountId: "acc_other",
      amount: "6.00",
      currencyCode: "USD",
      pricingMode: "derived",
    },
  ];
  function input(overrides: Partial<RepricingRuleDirective> = {}): RepricingListingEvaluationInput {
    return listing({
      rules: [
        {
          conditions: [],
          directive: {
            ...directive,
            anchorChain: [anyAnchor, { source: "last-sold" }],
            offset: { mode: "absolute", amount: "0.00" },
            ...overrides,
          },
        },
      ],
    });
  }
  function market(overrides: Partial<RepricingMarketInputSnapshot> = {}): RepricingMarketInputSnapshot {
    return snapshot({ marketEstimate: ground, competingAsks: asks, ...overrides });
  }

  it.each([undefined, "hard"] as const)("keeps %s strata hard-only in a mixed snapshot", (strata) => {
    const result = evaluateRepricingListing(
      input({ anchorChain: [{ source: "lowest-competing-ask", ...(strata ? { strata } : {}) }] }),
      market(),
    );
    expect(result.anchor).toEqual({
      source: "lowest-competing-ask",
      amount: "10.00",
      stratum: "hard-ask",
      contributingListingCount: 1,
    });
    expect(result.flags).toEqual([]);
  });

  it.each([
    ["6.00", "8.10", ["band-binding"]],
    ["8.50", "8.50", []],
    ["8.10", "8.10", []],
  ])("anchors on any ask %s with exact band binding", (amount, expected, flags) => {
    const result = evaluateRepricingListing(input(), market({ competingAsks: [asks[0]!, { ...asks[1]!, amount }] }));
    expect(result.anchor).toEqual({
      source: "lowest-competing-ask",
      amount: expected,
      stratum: "any-ask",
      contributingListingCount: 2,
    });
    expect(result.targetPriceAmount).toBe(expected);
    expect(result.flags).toEqual(flags);
    expect(result.exhaustedAnchors).toEqual([]);
    const serialized = JSON.stringify(result);
    for (const forbidden of [asks[0]!.listingId, asks[1]!.listingId, "pricingMode", "derived"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    null,
    { ...ground, freshUntil: "2026-07-16T00:00:00.000Z" },
    { ...ground, currencyCode: "EUR" },
    { ...ground, currencyCode: null },
    { ...ground, currencyCode: undefined },
    { ...ground, freshUntil: "invalid" },
    { ...ground, amount: "invalid" },
    { ...ground, amount: "-9.00" },
  ])("exhausts unavailable or malformed ground %j as absent and continues", (marketEstimate) => {
    const result = evaluateRepricingListing(
      input(),
      market({
        marketEstimate,
        competingAsks: [...asks, { ...asks[0]!, listingId: "lst_second_hard", amount: "12.00" }],
      }),
    );
    expect(result.exhaustedAnchors).toEqual([{ source: "lowest-competing-ask", state: "absent" }]);
    expect(result.anchor).toEqual({
      source: "last-sold",
      amount: "11.00",
      stratum: "last-sold",
      contributingListingCount: 0,
    });
    expect(result.action).toBe("update-price");
    expect(result.flags).toEqual([]);
  });

  it("treats ground exactly at its freshness boundary as present", () => {
    expect(
      evaluateRepricingListing(input(), market({ marketEstimate: { ...ground, freshUntil: snapshot().capturedAt } }))
        .flags,
    ).toEqual(["band-binding"]);
  });

  it("exhausts missing ground into hard, or the terminal when the chain ends", () => {
    const fallback = evaluateRepricingListing(
      input({ anchorChain: [anyAnchor, { source: "lowest-competing-ask" }] }),
      market({ marketEstimate: null }),
    );
    expect(fallback.anchor?.stratum).toBe("hard-ask");
    expect(fallback.flags).toEqual([]);
    const terminal = evaluateRepricingListing(
      input({ anchorChain: [anyAnchor], terminal: { kind: "fallback-price", amount: "7.00" } }),
      market({ marketEstimate: null }),
    );
    expect(terminal.targetPriceAmount).toBe("7.00");
    expect(terminal.anchor).toBeNull();
    expect(terminal.flags).toEqual([]);
  });

  it("preserves seller exclusion, currency filtering, and estimate-core outliers for both ask modes", () => {
    const result = evaluateRepricingListing(
      input(),
      market({
        hardAskOutlierPriceRatio: 2,
        competingAsks: [
          ...asks,
          { ...asks[1]!, listingId: "lst_own_derived", sellerAccountId: "acc_policy", amount: "8.20" },
          { ...asks[0]!, listingId: "lst_own_hard", sellerAccountId: "acc_policy", amount: "8.30" },
          { ...asks[1]!, listingId: "lst_eur", currencyCode: "EUR", amount: "8.40" },
          { ...asks[1]!, listingId: "lst_currency_missing", currencyCode: null, amount: "8.40" },
          { ...asks[0]!, listingId: "lst_low_outlier", amount: "0.01" },
          { ...asks[1]!, listingId: "lst_high_outlier", amount: "1000.00" },
        ],
      }),
    );
    expect(result.anchor).toEqual({
      source: "lowest-competing-ask",
      amount: "8.10",
      stratum: "any-ask",
      contributingListingCount: 2,
    });
    expect(result.flags).toEqual(["band-binding"]);
  });

  it("preserves the outlier guard's all-filtered fallback and single-ask behavior", () => {
    for (const competingAsks of [[{ ...asks[1]!, amount: "0.01" }], asks.map((ask) => ({ ...ask, amount: "0.01" }))]) {
      const result = evaluateRepricingListing(input(), market({ hardAskOutlierPriceRatio: 2, competingAsks }));
      expect(result.anchor?.amount).toBe("8.10");
      expect(result.anchor?.contributingListingCount).toBe(competingAsks.length);
      expect(result.flags).toEqual(["band-binding"]);
    }
  });

  it("does not turn a ground estimate into an ask when only the seller has listings", () => {
    const result = evaluateRepricingListing(
      input(),
      market({ competingAsks: asks.map((ask) => ({ ...ask, sellerAccountId: "acc_policy" })) }),
    );
    expect(result.exhaustedAnchors).toEqual([{ source: "lowest-competing-ask", state: "absent" }]);
    expect(result.anchor?.source).toBe("last-sold");
  });

  it.each([null, "EUR"])(
    "retains no-reprice for incompatible competing asks (%s), not missing ground",
    (currencyCode) => {
      const result = evaluateRepricingListing(input(), market({ competingAsks: [{ ...asks[1]!, currencyCode }] }));
      expect(result.action).toBe("no-reprice");
      expect(result.exhaustedAnchors).toEqual([
        { source: "lowest-competing-ask", state: currencyCode ? "currency-mismatch" : "currency-incomplete" },
      ]);
    },
  );

  it("keeps comp-percentile and competing-count conditions hard-only alongside an any anchor", () => {
    const percentile = evaluateRepricingListing(
      input({ anchorChain: [{ source: "comp-percentile", percentile: 50 }, anyAnchor] }),
      market(),
    );
    expect(percentile.anchor).toEqual({
      source: "comp-percentile",
      amount: "10.00",
      stratum: "hard-ask",
      contributingListingCount: 1,
    });
    const result = evaluateRepricingListing(
      listing({
        rules: [
          { ...input().rules[0]!, conditions: [{ type: "competing-listing-count-at-least", count: 2 }] },
          { conditions: [], directive: { ...directive, anchorChain: [{ source: "lowest-competing-ask" }] } },
        ],
      }),
      market(),
    );
    expect(result.ruleIndex).toBe(1);
    expect(result.anchor?.stratum).toBe("hard-ask");
  });

  it.each([
    [50, "4.51"],
    [90, "8.11"],
    [90.001, "8.11"],
    [100, "9.01"],
  ])("never rounds below a fractional-cent band at %s percent", (minPercentOfGround, expected) => {
    const result = evaluateRepricingListing(
      input({ anchorChain: [{ ...anyAnchor, band: { ground: "market-estimate", minPercentOfGround } }] }),
      market({
        marketEstimate: { ...ground, amount: "9.01" },
        competingAsks: [{ ...asks[1]!, amount: "1.00" }],
      }),
    );
    expect(result.anchor?.amount).toBe(expected);
  });

  it("preserves decimal percentages finer than basis points", () => {
    const result = evaluateRepricingListing(
      input({ anchorChain: [{ ...anyAnchor, band: { ground: "market-estimate", minPercentOfGround: 90.001 } }] }),
      market({ competingAsks: [{ ...asks[1]!, amount: "1.00" }] }),
    );
    expect(result.anchor?.amount).toBe("8.11");
  });

  it("keeps band binding distinct from terminal price clamps and tolerance", () => {
    const result = evaluateRepricingListing(input({ floor: { mode: "absolute", amount: "10.00" } }), market());
    expect(result.anchor?.amount).toBe("8.10");
    expect(result.targetPriceAmount).toBe("10.00");
    expect(result.flags).toEqual(["band-binding", "floor-binding"]);
    expect(result.action).toBe("hold");
  });
});

describe("repricing product-round evaluation", () => {
  it("preserves the unchanged-hard golden fixture byte for byte", () => {
    const input = snapshot({ competingAsks: snapshot().competingAsks.filter((ask) => ask.pricingMode === "hard") });
    const golden =
      '{"listingId":"lst_policy","currentPriceAmount":"10.00","targetPriceAmount":"10.99","ruleIndex":0,"anchor":{"source":"lowest-competing-ask","amount":"11.00","stratum":"hard-ask","contributingListingCount":1},"exhaustedAnchors":[],"clamps":{"floor":false,"ceiling":false,"maxMove":false},"tolerance":{"mode":"absolute","amount":"0.25"},"flags":[],"action":"update-price","skipReason":null}';
    expect(JSON.stringify(evaluateRepricingListing(listing(), input))).toBe(golden);
  });

  it("returns named no-reprice for an undenominated current Listing price", () => {
    const result = evaluateRepricingListing(listing({ currentPriceCurrencyCode: null }), snapshot());

    expect(result).toMatchObject({
      action: "no-reprice",
      targetPriceAmount: null,
      skipReason: "currency-input-incomplete-or-mismatched",
    });
  });

  it("returns named no-reprice instead of falling through a mismatched estimate", () => {
    const result = evaluateRepricingListing(
      listing({
        rules: [
          {
            conditions: [],
            directive: { ...directive, currencyCode: "EUR", anchorChain: [{ source: "market-estimate" }] },
          },
        ],
        currentPriceCurrencyCode: "EUR",
      }),
      snapshot({
        marketEstimate: { amount: "12.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" },
        competingAsks: [],
      }),
    );

    expect(result.action).toBe("no-reprice");
    expect(result.exhaustedAnchors).toEqual([{ source: "market-estimate", state: "currency-mismatch" }]);
  });

  it("does not drop a mismatched preferred estimate when a later competitor anchor is valid", () => {
    const result = evaluateRepricingListing(
      listing({
        currentPriceCurrencyCode: "EUR",
        rules: [
          {
            conditions: [],
            directive: {
              ...directive,
              currencyCode: "EUR",
              anchorChain: [{ source: "market-estimate" }, { source: "lowest-competing-ask" }],
            },
          },
        ],
      }),
      snapshot({
        marketEstimate: { amount: "12.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" },
        competingAsks: [
          {
            listingId: "lst_eur",
            sellerAccountId: "acc_other",
            amount: "11.00",
            currencyCode: "EUR",
            pricingMode: "hard",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      action: "no-reprice",
      targetPriceAmount: null,
      skipReason: "currency-input-incomplete-or-mismatched",
    });
  });

  it("keeps percentage-only movement relative within the Listing currency", () => {
    const result = evaluateRepricingListing(
      listing({
        currentPriceCurrencyCode: "EUR",
        rules: [
          {
            conditions: [],
            directive: {
              ...directive,
              currencyCode: "EUR",
              offset: { mode: "percent", percent: -10 },
              tolerance: { mode: "percent", percent: 1 },
            },
          },
        ],
      }),
      snapshot({
        marketEstimate: null,
        competingAsks: [
          {
            listingId: "lst_eur",
            sellerAccountId: "acc_other",
            amount: "20.00",
            currencyCode: "EUR",
            pricingMode: "hard",
          },
        ],
      }),
    );

    expect(result).toMatchObject({ action: "update-price", targetPriceAmount: "18.00" });
  });

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
        marketEstimate: { amount: "12.00", currencyCode: "USD", freshUntil: "2026-07-16T00:00:00.000Z" },
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
        competingAsks: [
          {
            listingId: "lst_hard",
            sellerAccountId: "acc_other",
            amount: "10.20",
            currencyCode: "USD",
            pricingMode: "hard",
          },
        ],
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
      listing({
        currentPriceAmount: "20.00",
        costBasisAmount: "12.00",
        costBasisCurrencyCode: "USD",
        rules,
      }),
      snapshot({ marketEstimate: { amount: "20.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" } }),
    );

    expect(result.targetPriceAmount).toBe("15.00");
    expect(result.clamps.ceiling).toBe(true);
    expect(result.clamps.maxMove).toBe(true);
    expect(result.flags).toEqual(["ceiling-binding", "max-move-binding"]);
  });

  it.each([null, "EUR"])(
    "returns no-reprice for an acquisition-cost amount with %s currency instead of dropping it to the fallback floor",
    (costBasisCurrencyCode) => {
      const result = evaluateRepricingListing(listing({ costBasisAmount: "12.00", costBasisCurrencyCode }), snapshot());

      expect(result).toMatchObject({
        action: "no-reprice",
        targetPriceAmount: null,
        skipReason: "currency-input-incomplete-or-mismatched",
      });
    },
  );

  it("keeps a floor terminal when max-move would otherwise leave the range", () => {
    const result = evaluateRepricingListing(
      listing({
        currentPriceAmount: "10.00",
        rules: [
          {
            conditions: [],
            directive: {
              ...directive,
              anchorChain: [{ source: "market-estimate" }],
              offset: { mode: "absolute", amount: "0.00" },
              floor: { mode: "absolute", amount: "15.00" },
              maxMovePercent: 10,
            },
          },
        ],
      }),
      snapshot({ marketEstimate: { amount: "1.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" } }),
    );

    expect(result.targetPriceAmount).toBe("15.00");
    expect(result.clamps).toMatchObject({ floor: true, maxMove: true });
  });

  it("keeps a ceiling terminal when max-move would otherwise leave the range", () => {
    const result = evaluateRepricingListing(
      listing({
        currentPriceAmount: "100.00",
        rules: [
          {
            conditions: [],
            directive: {
              ...directive,
              anchorChain: [{ source: "market-estimate" }],
              offset: { mode: "absolute", amount: "0.00" },
              ceiling: { mode: "absolute", amount: "60.00" },
              maxMovePercent: 10,
            },
          },
        ],
      }),
      snapshot({ marketEstimate: { amount: "100.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" } }),
    );

    expect(result.targetPriceAmount).toBe("60.00");
    expect(result.clamps).toMatchObject({ ceiling: true, maxMove: false });
  });

  it("filters an absurd hard ask before resolving the hard-ask stratum", () => {
    const result = evaluateRepricingListing(
      listing(),
      snapshot({
        marketEstimate: { amount: "100.00", currencyCode: "USD", freshUntil: "2026-07-18T00:00:00.000Z" },
        competingAsks: [
          {
            listingId: "lst_real",
            sellerAccountId: "acc_real",
            amount: "99.00",
            currencyCode: "USD",
            pricingMode: "hard",
          },
          {
            listingId: "lst_absurd",
            sellerAccountId: "acc_absurd",
            amount: "0.01",
            currencyCode: "USD",
            pricingMode: "hard",
          },
        ],
      }),
    );

    expect(result.anchor).toMatchObject({ amount: "99.00", contributingListingCount: 1 });
    expect(result.targetPriceAmount).toBe("98.99");
  });

  it("treats a stale last-sold fallback as exhausted", () => {
    const result = evaluateRepricingListing(
      listing({ rules: [{ conditions: [], directive: { ...directive, anchorChain: [{ source: "last-sold" }] } }] }),
      snapshot({
        competingAsks: [],
        lastSold: { amount: "11.00", currencyCode: "USD", freshUntil: "2026-07-17T11:59:59.999Z" },
      }),
    );

    expect(result.action).toBe("hold");
    expect(result.exhaustedAnchors).toEqual([{ source: "last-sold", state: "stale" }]);
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
          currencyCode: "USD",
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
