import { describe, expect, it } from "vitest";
import { evaluateBuyerOfferTarget, type BuyerOfferTargetInput } from "./evaluate";

const input: BuyerOfferTargetInput = {
  selection: {
    offerId: "offer_1",
    offerVersion: 2,
    catalogItemId: "item_1",
    productId: "item_1::",
    selectedOptions: [],
    quantity: 1,
    maximumUnitItemAmount: "20.00",
  },
  currency: "USD",
  adjustmentBps: 0,
  policyRevision: 3,
  marketPrice: {
    catalogItemId: "item_1",
    productId: "item_1::",
    estimateVersion: "7",
    amount: "10.01",
    currencyCode: "usd",
    estimatedAt: "2026-09-27T11:00:00.000Z",
    freshUntil: "2026-09-27T13:00:00.000Z",
  },
  evaluatedAt: "2026-09-27T12:00:00.000Z",
};

function withChanges(changes: Partial<BuyerOfferTargetInput>): BuyerOfferTargetInput {
  return { ...input, ...changes };
}

describe("market-following buyer Offer target", () => {
  it.each([
    ["default", "10.01", 0, "20.00", "10.01"],
    ["minus 25 percent", "10.00", -2500, "20.00", "7.50"],
    ["cap after adjustment", "10.00", -2500, "6.00", "6.00"],
    ["fractional cent floors", "0.03", -2500, "20.00", "0.02"],
    ["quantity never multiplies", "10.00", 0, "20.00", "10.00"],
  ])("pins literal %s cents", (_name, amount, adjustmentBps, cap, expected) => {
    const result = evaluateBuyerOfferTarget(
      withChanges({
        adjustmentBps,
        selection: { ...input.selection, quantity: 100, maximumUnitItemAmount: cap },
        marketPrice: { ...input.marketPrice!, amount },
      }),
    );
    expect(result.status).toBe("target");
    if (result.status === "target") expect(result.unitItemAmount).toBe(expected);
  });

  it("holds a floored zero instead of emitting a zero-price Offer", () => {
    expect(
      evaluateBuyerOfferTarget(
        withChanges({
          adjustmentBps: -2500,
          marketPrice: { ...input.marketPrice!, amount: "0.01" },
        }),
      ),
    ).toMatchObject({ status: "held", reason: "target-below-minimum" });
  });

  it.each([-2501, 1, 0.5, NaN, Infinity])("rejects unauthorized adjustment %s", (adjustmentBps) => {
    expect(() => evaluateBuyerOfferTarget(withChanges({ adjustmentBps }))).toThrow("Invalid authorized");
  });

  it.each(["0.00", "-1.00", "1.001", "1", "10000000000.00", "abc"])("rejects invalid cap %s", (cap) => {
    expect(() =>
      evaluateBuyerOfferTarget(
        withChanges({
          selection: { ...input.selection, maximumUnitItemAmount: cap },
        }),
      ),
    ).toThrow("Invalid authorized");
  });

  it.each([
    ["absent", { marketPrice: null }, "market-price-unavailable"],
    ["missing currency", { marketPrice: { ...input.marketPrice!, currencyCode: "" } }, "market-price-invalid"],
    [
      "wrong currency",
      { marketPrice: { ...input.marketPrice!, currencyCode: "eur" } },
      "market-price-currency-mismatch",
    ],
    [
      "wrong Product",
      { marketPrice: { ...input.marketPrice!, productId: "other::" } },
      "market-price-product-mismatch",
    ],
    [
      "wrong catalog item",
      { marketPrice: { ...input.marketPrice!, catalogItemId: "other" } },
      "market-price-product-mismatch",
    ],
    ["unknown version", { marketPrice: { ...input.marketPrice!, estimateVersion: "0" } }, "market-price-invalid"],
    ["invalid amount", { marketPrice: { ...input.marketPrice!, amount: "0.00" } }, "market-price-invalid"],
    ["stale", { evaluatedAt: "2026-09-27T13:00:00.001Z" }, "market-price-stale"],
    ["expiry instant", { evaluatedAt: "2026-09-27T13:00:00.000Z" }, "market-price-stale"],
    [
      "future generation",
      { marketPrice: { ...input.marketPrice!, estimatedAt: "2026-09-27T12:00:00.001Z" } },
      "market-price-stale",
    ],
    [
      "invalid generation",
      { marketPrice: { ...input.marketPrice!, estimatedAt: "2026-02-30T11:00:00.000Z" } },
      "market-price-invalid",
    ],
    ["missing generation", { marketPrice: { ...input.marketPrice!, estimatedAt: "" } }, "market-price-invalid"],
    ["invalid horizon", { marketPrice: { ...input.marketPrice!, freshUntil: "not-a-date" } }, "market-price-invalid"],
    [
      "reversed horizon",
      { marketPrice: { ...input.marketPrice!, freshUntil: "2026-09-27T10:00:00.000Z" } },
      "market-price-invalid",
    ],
    [
      "old generation with an extended horizon",
      {
        marketPrice: {
          ...input.marketPrice!,
          estimatedAt: "2026-08-01T11:00:00.000Z",
          freshUntil: "2026-10-01T11:00:00.000Z",
        },
      },
      "market-price-invalid",
    ],
    ["invalid attempted time", { evaluatedAt: "not-a-date" }, "evaluation-time-invalid"],
  ] as const)("holds %s with buyer-safe explanation", (_name, changes, reason) => {
    const result = evaluateBuyerOfferTarget(withChanges(changes));
    expect(result).toMatchObject({ status: "held", reason });
    if (result.status === "held") expect(result.buyerCopy.length).toBeGreaterThan(10);
  });

  it("uses one evaluator for retained preview and attempted application inputs", () => {
    const retained = structuredClone(input);
    const preview = evaluateBuyerOfferTarget(retained);
    expect(preview).toEqual(evaluateBuyerOfferTarget(retained));
    expect(preview).toMatchObject({
      status: "target",
      unitItemAmount: "10.01",
      evidence: {
        policyRevision: 3,
        adjustmentBps: 0,
        maximumUnitItemAmount: "20.00",
        marketPrice: { estimateVersion: "7", amount: "10.01" },
      },
    });
    expect(
      evaluateBuyerOfferTarget(
        withChanges({ marketPrice: { ...input.marketPrice!, estimateVersion: "8", amount: "12.00" } }),
      ),
    ).toMatchObject({ status: "target", unitItemAmount: "12.00", evidence: { marketPrice: { estimateVersion: "8" } } });
    expect(evaluateBuyerOfferTarget(withChanges({ evaluatedAt: "2026-09-27T13:00:00.000Z" }))).toMatchObject({
      status: "held",
      reason: "market-price-stale",
    });
  });

  it("excludes seller and opposing data even when callers perturb extra fields", () => {
    const unexpected = { lowestCompetingAsk: "0.01", demandCurve: [1], sellerFloor: "99.00", sellerProfit: "99.00" };
    const baseline = evaluateBuyerOfferTarget(input);
    const perturbed = evaluateBuyerOfferTarget({
      ...input,
      ...unexpected,
      selection: { ...input.selection, ...unexpected },
      marketPrice: { ...input.marketPrice!, ...unexpected },
    });
    expect(perturbed).toEqual(baseline);
    expect(Object.keys(perturbed.evidence).sort()).toEqual([
      "adjustmentBps",
      "catalogItemId",
      "currency",
      "evaluatedAt",
      "marketPrice",
      "maximumUnitItemAmount",
      "offerId",
      "offerVersion",
      "policyRevision",
      "productId",
      "quantity",
      "selectedOptions",
    ]);
    expect(Object.keys(perturbed.evidence.marketPrice!).sort()).toEqual([
      "amount",
      "catalogItemId",
      "currencyCode",
      "estimateVersion",
      "estimatedAt",
      "freshUntil",
      "productId",
    ]);
  });
});
