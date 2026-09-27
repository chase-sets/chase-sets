import { describe, expect, it, vi } from "vitest";
import { createBuyerOfferPricing } from "./queries";
import type { BuyerOfferTargetInput } from "../domain/evaluate";

describe("buyer Offer Pricing public adapter", () => {
  const request: Omit<BuyerOfferTargetInput, "marketPrice"> = {
    selection: {
      offerId: "off_one",
      offerVersion: 2,
      catalogItemId: "cat_one",
      productId: "cat_one::",
      selectedOptions: [],
      quantity: 2,
      maximumUnitItemAmount: "20.00",
    },
    currency: "USD",
    policyRevision: 1,
    adjustmentBps: -1000,
    evaluatedAt: "2026-09-27T12:00:00.000Z",
  };
  it("uses one batched loader read and the Pricing evaluator for every target", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            catalog_item_id: "cat_one",
            product_id: "cat_one::",
            estimate_version: "7",
            amount: "15.00",
            currency_code: "USD",
            estimated_at: new Date("2026-09-27T11:00:00Z"),
            fresh_until: new Date("2026-09-27T13:00:00Z"),
          },
        ],
      })),
    };
    const result = await createBuyerOfferPricing(db).evaluateTargets([
      request,
      { ...request, selection: { ...request.selection, offerId: "off_two" } },
    ]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(result.map((r) => r.status === "target" && r.unitItemAmount)).toEqual(["13.50", "13.50"]);
    expect(result[1]!.evidence).toMatchObject({ offerId: "off_two", marketPrice: { estimateVersion: "7" } });
  });
  it("preserves held results for missing and stale evidence", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await createBuyerOfferPricing(db).evaluateTargets([request])).toMatchObject([
      { status: "held", reason: "market-price-unavailable" },
    ]);
  });
});
