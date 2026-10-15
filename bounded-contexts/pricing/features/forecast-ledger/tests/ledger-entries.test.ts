import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import { repricingPolicyEvaluatedEventType } from "../../repricing-engine/domain/fact";
import { BUYER_CHOICE_CALIBRATION, estimateBuyerChoiceSellDays } from "../domain/buyer-choice";
import {
  CONDITION_RATE_METHOD,
  conditionRateMedianSellDays,
  estimateConditionSaleIntervalDays,
} from "../domain/condition-rate";
import { forecastKindDefinitions, withForecasts, type ForecastCurve } from "../domain/forecast-kinds";
import { pricedLedgerEntries } from "../domain/ledger";
import { buildForecastLedgerProjectionHandlers } from "../read-model/projection";
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
const evaluation = { pricedAt: "2026-08-01T00:00:00.000Z", curve };
const recorded = { curve: { medianSellDays: 12, model: "pooled-supply-v1" } };

describe("Forecast Ledger entries of one evaluation", () => {
  it("records an emitted price and a price held within tolerance, but not a skip that left another price listed", () => {
    const entries = pricedLedgerEntries(
      evaluatedData([
        listingTrace({ listingId: "lst_changed", forecasts: recorded }),
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
      forecasts: recorded,
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
            shadowTrace({ forecasts: recorded }),
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
    expect(entries.map((entry) => [entry.entryId, entry.priceAmount, entry.forecasts])).toEqual([
      ["evl_synthetic:lst_a:shadow:fixed-percentile@2:0", "5.50", recorded],
      ["evl_synthetic:lst_a:shadow:target-horizon@2:1", "6.00", {}],
    ]);
  });

  it("keeps an evaluation recorded before its forecasts were fixed as pricing with no forecast and an unknown quantity", () => {
    const [incumbent, shadow] = pricedLedgerEntries(
      evaluatedData([listingTrace({ listingId: "lst_legacy", quantity: undefined, shadow: [shadowTrace()] })]),
    );
    expect([incumbent!.quantity, incumbent!.forecasts, shadow!.forecasts]).toEqual([null, {}, {}]);
  });

  it("projects an evaluation's recorded forecasts and reads nothing else, however late its first projection or replay", async () => {
    const statements: string[] = [];
    const inserted: unknown[] = [];
    const db = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        statements.push(sql);
        inserted.push((params[14] as readonly string[]).map((forecasts) => JSON.parse(forecasts)));
        return { rows: [] };
      },
    } as unknown as PgTransactionalPool;
    const handler = buildForecastLedgerProjectionHandlers(db)[repricingPolicyEvaluatedEventType]!;
    const event = {
      globalPosition: "1",
      data: evaluatedData([
        listingTrace({ listingId: "lst_a", forecasts: recorded, shadow: [shadowTrace({ forecasts: {} })] }),
      ]),
    };
    await handler(event as never);
    await handler(event as never, { db } as never);
    expect(statements).toHaveLength(2);
    expect(statements.every((sql) => sql.includes("INSERT INTO pricing_forecast_ledger_entries"))).toBe(true);
    expect(inserted).toEqual([
      [recorded, {}],
      [recorded, {}],
    ]);
  });
});

describe("forecasts fixed when a price is evaluated", () => {
  it("takes every registered forecast at the price from the curve and provider weeks the evaluation read", () => {
    const priced = withForecasts(forecastKindDefinitions(), listingTrace({ listingId: "lst_a" }), evaluation);
    expect(priced.forecasts).toEqual({
      curve: { medianSellDays: 12, model: "pooled-supply-v1" },
      "buyer-choice": {
        medianSellDays: estimateBuyerChoiceSellDays({ buyerIntervalDays: 3, competingSellers: 2 }, 5)!,
        model: BUYER_CHOICE_CALIBRATION.name,
      },
      "condition-rate": {
        medianSellDays: conditionRateMedianSellDays(
          estimateConditionSaleIntervalDays(curve.conditionSales, Date.parse(evaluation.pricedAt)),
          0.4,
        )!,
        model: CONDITION_RATE_METHOD,
      },
    });
  });

  it("takes no curve forecast for a fallback anchor, nothing without a curve, and leaves an unpriced trace alone", () => {
    const kinds = forecastKindDefinitions();
    const fallback = withForecasts(
      kinds,
      shadowTrace({
        anchor: { source: "market-estimate", amount: "5.00", stratum: "market-estimate", contributingListingCount: 0 },
        targetPriceAmount: "5.00",
      }),
      evaluation,
    );
    expect(Object.keys(fallback.forecasts!).sort()).toEqual(["buyer-choice", "condition-rate"]);
    expect(
      withForecasts(kinds, listingTrace({ listingId: "lst_a" }), { ...evaluation, curve: null }).forecasts,
    ).toEqual({});
    const paused = shadowTrace({ action: "pause", targetPriceAmount: null, anchor: null });
    expect(withForecasts(kinds, paused, evaluation)).toBe(paused);
    expect(
      withForecasts(
        kinds,
        listingTrace({
          listingId: "lst_a",
          anchor: {
            ...listingTrace({ listingId: "lst_a" }).anchor!,
            goal: goalTrace({ forecastStatus: "unavailable" }),
          },
        }),
        evaluation,
      ).forecasts,
    ).not.toHaveProperty("curve");
  });
});
