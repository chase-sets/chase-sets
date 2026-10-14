import { describe, expect, it } from "vitest";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import { forecastKindDefinitions, type ForecastCurve } from "../domain/forecast-kinds";
import { pricedLedgerEntries, toForecastLedgerEntries } from "../domain/ledger";
import { evaluatedData, goalTrace, listingTrace, shadowTrace } from "./fixtures/evaluated-event";

const point: CurvePoint = {
  percentile: 50,
  priceAmount: "5.00",
  buyerArrivalIntervalDays: 3,
  competingSellerCount: 2,
  storeWinShare: 0.4,
  medianSellDays: 5,
  qualifyingSaleCount: 8,
  historyCapped: false,
  hopeless: false,
  supplyStatus: "observed",
};
const curve: ForecastCurve = {
  modelVersion: "pooled-supply-v1",
  points: [point],
  conditionSales: [{ weekStart: "2026-07-27", transactionCount: 3 }],
};

describe("Forecast Ledger entries of one evaluation", () => {
  it("records an emitted price and a price held within tolerance, but not a skip that left another price listed", () => {
    const entries = pricedLedgerEntries(
      evaluatedData([
        listingTrace({ listingId: "lst_changed" }),
        listingTrace({ listingId: "lst_held", outcome: "skipped", skipReason: "within-tolerance" }),
        listingTrace({ listingId: "lst_budget", outcome: "skipped", skipReason: "budget-exhausted" }),
        listingTrace({ listingId: "lst_conflict", outcome: "skipped", skipReason: "manual-edit-conflict" }),
        listingTrace({
          listingId: "lst_paused",
          outcome: "pause-requested",
          skipReason: "terminal-pause",
          targetPriceAmount: null,
        }),
        listingTrace({
          listingId: "lst_market",
          anchor: {
            source: "market-estimate",
            amount: "5.00",
            stratum: "market-estimate",
            contributingListingCount: 0,
          },
        }),
      ]),
    );
    expect(entries.map((entry) => [entry.listingId, entry.role])).toEqual([
      ["lst_changed", "incumbent"],
      ["lst_held", "incumbent"],
    ]);
    expect(entries[0]).toEqual({
      entryId: "evl_synthetic:lst_changed:incumbent:fixed-percentile@1",
      evaluationId: "evl_synthetic",
      sellerAccountId: "acc_seller",
      catalogItemId: "cat_synthetic",
      productId: "prd_synthetic",
      listingId: "lst_changed",
      role: "incumbent",
      goalId: "fixed-percentile",
      goalVersion: 1,
      curveVersion: 3,
      priceAmount: "5.00",
      quantity: 1,
      pricedAt: "2026-08-01T00:00:00.000Z",
      goalForecast: { medianSellDays: 12, status: "interpolated" },
    });
  });

  it("records every priced shadow entry, including one beside a skipped incumbent, and never an unpriced one", () => {
    const entries = pricedLedgerEntries(
      evaluatedData([
        listingTrace({
          listingId: "lst_a",
          outcome: "skipped",
          skipReason: "budget-exhausted",
          shadow: [
            shadowTrace(),
            shadowTrace({
              anchorIndex: 1,
              goalId: "target-horizon",
              anchor: {
                source: "market-estimate",
                amount: "6.00",
                stratum: "market-estimate",
                contributingListingCount: 0,
              },
              targetPriceAmount: "6.00",
            }),
            shadowTrace({ anchorIndex: 2, action: "pause", targetPriceAmount: null, anchor: null }),
            {
              goalId: "profit-per-day",
              goalVersion: 2,
              anchorIndex: 3,
              curveVersion: null,
              targetPriceAmount: null,
              action: null,
              skipReason: null,
              anchor: null,
              flags: [],
              skipped: "parameters-incompatible",
            },
          ],
        }),
      ]),
    );
    expect(entries.map((entry) => [entry.entryId, entry.priceAmount, entry.goalForecast])).toEqual([
      ["evl_synthetic:lst_a:shadow:fixed-percentile@2:0", "5.50", { medianSellDays: 15, status: "interpolated" }],
      ["evl_synthetic:lst_a:shadow:target-horizon@2:1", "6.00", null],
    ]);
  });

  it("takes each registered forecast once per entry; a fallback anchor carries no curve forecast and an untraced quantity is null", () => {
    const [incumbent, fallback] = toForecastLedgerEntries(
      pricedLedgerEntries(
        evaluatedData([
          listingTrace({
            listingId: "lst_a",
            quantity: undefined,
            anchor: {
              source: "curve-objective",
              amount: "5.00",
              stratum: "curve-objective",
              contributingListingCount: 0,
              goal: goalTrace(),
            },
            shadow: [
              shadowTrace({
                anchor: {
                  source: "market-estimate",
                  amount: "5.00",
                  stratum: "market-estimate",
                  contributingListingCount: 0,
                },
                targetPriceAmount: "5.00",
              }),
            ],
          }),
        ]),
      ),
      (version) => (version === 3 ? curve : null),
      forecastKindDefinitions(),
    );
    expect(incumbent!.quantity).toBeNull();
    expect(Object.keys(incumbent!.forecasts).sort()).toEqual(["buyer-choice", "condition-rate", "curve"]);
    expect(incumbent!.forecasts.curve).toEqual({ medianSellDays: 12, model: "pooled-supply-v1" });
    expect(Object.keys(fallback!.forecasts).sort()).toEqual(["buyer-choice", "condition-rate"]);
    expect(fallback!.forecasts["buyer-choice"]).toEqual(incumbent!.forecasts["buyer-choice"]);
  });
});
