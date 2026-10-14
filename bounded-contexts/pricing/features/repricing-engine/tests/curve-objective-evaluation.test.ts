import { afterEach, describe, expect, it, vi } from "vitest";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import { hopelessForecastHold } from "../../repricing-policies/domain/guardrails/hopeless-forecast-hold";
import { marketEvidenceFloor } from "../../repricing-policies/domain/guardrails/market-evidence-floor";
import {
  resolvedGoalEconomics,
  unavailableGoalEconomics,
} from "../../repricing-policies/tests/fixtures/goal-economics";
import { evaluateRepricingListing, type RepricingListingEconomics } from "../domain/evaluate";
import {
  freshUntil,
  goalAnchor,
  goalDirective,
  goalListing,
  goalSnapshot,
  otherSellerHardAsk,
  parityCurve,
  recordedDecision,
  typicalFeeTerms,
} from "./curve-objective-fixture";

const goals = [
  { goalId: "fixed-percentile", parameters: { percentile: 65 }, economics: null },
  { goalId: "target-horizon", parameters: { horizonDays: 30 }, economics: null },
  { goalId: "profit-per-day", parameters: {}, economics: { dailyReturnHurdle: 0.01, feeTerms: "typical" } },
] as const;

const economicsFor = (recorded: (typeof goals)[number]["economics"]) =>
  recorded === null ? null : resolvedGoalEconomics(typicalFeeTerms, recorded.dailyReturnHurdle);

describe("curve-objective anchor evaluation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("covers every registered Pricing Goal", () => {
    expect(goals.map(({ goalId }) => goalId).sort()).toEqual(pricingGoalDefinitions().map(({ id }) => id));
  });

  it.each(goals)(
    "prices $goalId on the parity curve and traces goal, version, curve version and forecast",
    ({ goalId, parameters, economics }) => {
      const recorded = recordedDecision(goalId, parameters, economics);
      const amount = recorded.selectedPrice.toFixed(2);
      const result = evaluateRepricingListing(
        goalListing(goalDirective({ anchorChain: [goalAnchor(goalId, parameters)] })),
        goalSnapshot({ economics: economicsFor(economics) }),
      );
      expect(result).toEqual({
        listingId: "lst_goal",
        currentPriceAmount: "10.00",
        targetPriceAmount: amount,
        ruleIndex: 0,
        anchor: {
          source: "curve-objective",
          amount,
          stratum: "curve-objective",
          contributingListingCount: 0,
          goal: {
            goalId,
            goalVersion: 1,
            curveVersion: 1,
            equivalentPercentile: recorded.equivalentPercentile,
            forecastMedianSellDays: recorded.estimatedMedianSellDays,
            forecastStatus: recorded.forecastStatus,
            unprofitable: recorded.unprofitable,
          },
        },
        exhaustedAnchors: [],
        clamps: { floor: false, ceiling: false, maxMove: false },
        tolerance: { mode: "absolute", amount: "0.01" },
        flags: [],
        action: "update-price",
        skipReason: null,
      });
    },
  );

  it.each(goals)(
    "honors tolerance hold for $goalId exactly as an existing anchor",
    ({ goalId, parameters, economics }) => {
      const amount = recordedDecision(goalId, parameters, economics).selectedPrice.toFixed(2);
      expect(
        evaluateRepricingListing(
          goalListing(goalDirective({ anchorChain: [goalAnchor(goalId, parameters)] }), { currentPriceAmount: amount }),
          goalSnapshot({ economics: economicsFor(economics) }),
        ),
      ).toMatchObject({ targetPriceAmount: amount, action: "hold", skipReason: "within-tolerance" });
    },
  );

  it("runs every stage in order: chain, pre-offset guardrails, offset, rounding, max move, post-max-move guardrails, floor, ceiling, tolerance", () => {
    const stages: Array<readonly [string, bigint]> = [];
    const hold = hopelessForecastHold.apply.bind(hopelessForecastHold);
    const floor = marketEvidenceFloor.apply.bind(marketEvidenceFloor);
    vi.spyOn(hopelessForecastHold, "apply").mockImplementation((context) => {
      stages.push([hopelessForecastHold.kind, context.targetCents]);
      return hold(context);
    });
    vi.spyOn(marketEvidenceFloor, "apply").mockImplementation((context) => {
      stages.push([marketEvidenceFloor.kind, context.targetCents]);
      return floor(context);
    });
    const result = evaluateRepricingListing(
      goalListing(
        goalDirective({
          // Authored out of slot order: each guardrail still runs in its own slot.
          guardrails: [{ kind: "market-evidence-floor", percentOfEstimate: 90 }, { kind: "hopeless-forecast-hold" }],
          offset: { mode: "percent", percent: -60 },
          rounding: { mode: "charm" },
          maxMovePercent: 65,
          ceiling: { mode: "absolute", amount: "3.90" },
        }),
      ),
      goalSnapshot(),
    );
    // 8.75 goal -> 3.50 offset -> 2.99 charm -> 3.50 max move -> 3.95 Curve Low floor -> 3.90 ceiling.
    expect(stages).toEqual([
      ["hopeless-forecast-hold", 875n],
      ["market-evidence-floor", 350n],
    ]);
    const atFinalPrice = recordedDecision("fixed-percentile", { percentile: 5 }, null);
    expect(result).toMatchObject({
      targetPriceAmount: "3.90",
      anchor: {
        amount: "8.75",
        goal: {
          // The forecast describes the moved 3.90 price, below the curve's lowest point, not the 8.75 goal price.
          equivalentPercentile: 5,
          forecastMedianSellDays: atFinalPrice.estimatedMedianSellDays,
          forecastStatus: "lower-bound",
        },
      },
      clamps: { floor: false, ceiling: true, maxMove: true, evidenceFloor: true },
      flags: ["ceiling-binding", "max-move-binding", "evidence-floor-binding"],
      action: "update-price",
    });
  });

  it("reports the forecast for a guardrail-moved price's equivalent percentile", () => {
    const result = evaluateRepricingListing(
      goalListing(
        goalDirective({
          guardrails: [{ kind: "market-evidence-floor", percentOfEstimate: 90 }],
          offset: { mode: "percent", percent: -60 },
        }),
      ),
      goalSnapshot(),
    );
    // 3.50 is raised to the 3.95 Curve Low, the parity curve's 5th-percentile point.
    const atMovedPrice = recordedDecision("fixed-percentile", { percentile: 5 }, null);
    expect(result).toMatchObject({
      targetPriceAmount: "3.95",
      anchor: {
        goal: {
          equivalentPercentile: atMovedPrice.equivalentPercentile,
          forecastMedianSellDays: atMovedPrice.estimatedMedianSellDays,
          forecastStatus: atMovedPrice.forecastStatus,
        },
      },
      clamps: { evidenceFloor: true },
      flags: ["evidence-floor-binding"],
    });
  });
});

describe("curve-objective anchor states", () => {
  const profitPerDay = goalAnchor("profit-per-day", {});
  const estimate = { amount: "12.00", currencyCode: "USD", freshUntil };
  const marketEstimateAnchor = {
    source: "market-estimate",
    amount: "12.00",
    stratum: "market-estimate",
    contributingListingCount: 0,
  };
  const noInventoryItem: RepricingListingEconomics = { availability: "unavailable", reason: "inventory-item-missing" };

  it.each([
    ["unavailable Economics", unavailableGoalEconomics()],
    ["a listing without an inventory item", noInventoryItem],
  ])(
    "exhausts profit-per-day with %s as absent economics-unavailable and continues the chain with no fee",
    (_, economics) => {
      const result = evaluateRepricingListing(
        goalListing(goalDirective({ anchorChain: [profitPerDay, { source: "market-estimate" }] })),
        goalSnapshot({ marketEstimate: estimate, economics }),
      );
      expect(result).toMatchObject({
        targetPriceAmount: "12.00",
        anchor: marketEstimateAnchor,
        exhaustedAnchors: [{ source: "curve-objective", state: "absent", reason: "economics-unavailable" }],
        action: "update-price",
      });
      expect(result.anchor).not.toHaveProperty("goal");
    },
  );

  it("ends at the terminal when unavailable Economics exhausts the only anchor", () => {
    expect(
      evaluateRepricingListing(
        goalListing(goalDirective({ anchorChain: [profitPerDay] })),
        goalSnapshot({ economics: unavailableGoalEconomics() }),
      ),
    ).toEqual(
      expect.objectContaining({
        targetPriceAmount: null,
        anchor: null,
        exhaustedAnchors: [{ source: "curve-objective", state: "absent", reason: "economics-unavailable" }],
        action: "hold",
        skipReason: "terminal-hold",
      }),
    );
  });

  it.each([
    [
      "a currency-mismatched curve",
      { demandCurve: { ...parityCurve, currencyCode: "EUR", freshUntil } },
      "currency-mismatch",
    ],
    [
      "a null-currency curve",
      { demandCurve: { ...parityCurve, currencyCode: null, freshUntil: null } },
      "currency-incomplete",
    ],
    [
      "Economics in another currency",
      { economics: resolvedGoalEconomics(typicalFeeTerms, 0.01, "eur") },
      "currency-mismatch",
    ],
  ] as const)("fails closed on %s with currency-input-incomplete-or-mismatched", (_, snapshot, state) => {
    expect(
      evaluateRepricingListing(
        goalListing(goalDirective({ anchorChain: [profitPerDay, { source: "market-estimate" }] })),
        goalSnapshot({
          marketEstimate: estimate,
          economics: resolvedGoalEconomics(typicalFeeTerms, 0.01),
          ...snapshot,
        }),
      ),
    ).toMatchObject({
      targetPriceAmount: null,
      anchor: null,
      exhaustedAnchors: [{ source: "curve-objective", state }],
      action: "no-reprice",
      skipReason: "currency-input-incomplete-or-mismatched",
    });
  });

  it.each([
    {
      name: "stale",
      snapshot: { demandCurve: { ...parityCurve, freshUntil: "2026-10-13T11:59:59.999Z" } },
      exhausted: { state: "stale" },
    },
    {
      name: "stale freshness-less",
      snapshot: { demandCurve: { ...parityCurve, freshUntil: null } },
      exhausted: { state: "stale" },
    },
    { name: "absent", snapshot: { demandCurve: null }, exhausted: { state: "absent" } },
    {
      name: "retired",
      anchor: { ...goalAnchor(), goalVersion: 2 },
      exhausted: { state: "absent", reason: "goal-retired" },
    },
    {
      name: "feature-missing",
      anchor: goalAnchor("target-horizon", { horizonDays: 30 }),
      snapshot: {
        demandCurve: {
          ...parityCurve,
          freshUntil,
          points: parityCurve.points.map((point) => ({ ...point, buyerArrivalIntervalDays: null })),
        },
      },
      exhausted: { state: "absent", reason: "curve-feature-missing:buyerArrivalIntervalDays" },
    },
  ])("reports a $name curve objective and continues to the next anchor", ({ anchor, snapshot, exhausted }) => {
    const result = evaluateRepricingListing(
      goalListing(goalDirective({ anchorChain: [anchor ?? goalAnchor(), { source: "market-estimate" }] })),
      goalSnapshot({ marketEstimate: estimate, ...snapshot }),
    );
    expect(result).toMatchObject({ targetPriceAmount: "12.00", anchor: marketEstimateAnchor, action: "update-price" });
    expect(result.exhaustedAnchors).toEqual([{ source: "curve-objective", ...exhausted }]);
  });

  it("prices usd Economics with a USD listing and curve prices, comparing ISO codes case-insensitively", () => {
    const recorded = recordedDecision("profit-per-day", {}, { dailyReturnHurdle: 0.01, feeTerms: "typical" });
    for (const currencyCode of ["USD", "usd"]) {
      expect(
        evaluateRepricingListing(
          goalListing(goalDirective({ anchorChain: [profitPerDay] })),
          goalSnapshot({
            demandCurve: { ...parityCurve, currencyCode, freshUntil },
            economics: resolvedGoalEconomics(typicalFeeTerms, 0.01, "usd"),
          }),
        ),
      ).toMatchObject({
        targetPriceAmount: recorded.selectedPrice.toFixed(2),
        anchor: { source: "curve-objective", goal: { goalId: "profit-per-day", unprofitable: false } },
        exhaustedAnchors: [],
      });
    }
  });

  it("leaves existing anchors byte-identical when a curve and Economics are captured", () => {
    const listing = goalListing(goalDirective({ anchorChain: [{ source: "lowest-competing-ask" }] }));
    const asks = { competingAsks: [otherSellerHardAsk("11.00")], marketEstimate: estimate };
    const without = evaluateRepricingListing(listing, goalSnapshot({ ...asks, demandCurve: null }));
    const withGoalInputs = evaluateRepricingListing(
      listing,
      goalSnapshot({ ...asks, economics: resolvedGoalEconomics(typicalFeeTerms, 0.01) }),
    );
    expect(JSON.stringify(withGoalInputs)).toBe(JSON.stringify(without));
    expect(JSON.stringify(without)).toBe(
      '{"listingId":"lst_goal","currentPriceAmount":"10.00","targetPriceAmount":"11.00","ruleIndex":0,"anchor":{"source":"lowest-competing-ask","amount":"11.00","stratum":"hard-ask","contributingListingCount":1},"exhaustedAnchors":[],"clamps":{"floor":false,"ceiling":false,"maxMove":false},"tolerance":{"mode":"absolute","amount":"0.01"},"flags":[],"action":"update-price","skipReason":null}',
    );
  });
});
