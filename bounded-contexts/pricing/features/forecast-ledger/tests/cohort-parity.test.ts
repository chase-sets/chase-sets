import { describe, expect, it } from "vitest";
import { buildForecastCohort, type ForecastHistoryEntry } from "../domain/cohort";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { appRecordsAsLedger, listingIdForSku, oracle } from "./fixtures/app-oracle";

const DAY_MS = 24 * 60 * 60 * 1000;
const { graceDays } = FORECAST_LEDGER_LAUNCH_POLICY_VALUE;

describe("Forecast Cohort parity with the app's buildCohort", () => {
  it("records the app at its pinned commit and the launch policy keeps the app's horizons and grace", () => {
    expect(oracle.sourceCommit).toBe("bdeffa0190be035084abccb464716aaaa2541a59");
    expect(oracle.sourceBlobs["app/features/pricing/domain/forecastGrading.ts"]).toBe(
      "155e487f5d59e6980fa71bd86fb6ea7e222121d3",
    );
    expect(FORECAST_LEDGER_LAUNCH_POLICY_VALUE.horizonsDays).toEqual(
      oracle.cohort.cohorts.map((cohort) => cohort.horizonDays),
    );
    expect(graceDays).toBe(2);
  });

  it.each(oracle.cohort.cohorts.map((cohort) => [cohort.horizonDays, cohort] as const))(
    "reproduces the app's membership, order, and outcomes at %i days, including censoring and grace",
    (horizonDays, recorded) => {
      const { entries, outcomes } = appRecordsAsLedger();
      const cohort = buildForecastCohort(entries, oracle.cohort.forecastNames, outcomes, { horizonDays, graceDays });
      expect(cohort.map(({ listingId, sold }) => ({ listingId, sold }))).toEqual(
        recorded.members.map(({ sku, sold }) => ({ listingId: listingIdForSku(sku), sold })),
      );
    },
  );

  it("discriminates every rule the fixture exercises", () => {
    const at = (horizonDays: number) => {
      const recorded = oracle.cohort.cohorts.find((cohort) => cohort.horizonDays === horizonDays)!;
      return new Map(recorded.members.map(({ sku, sold }) => [sku, sold]));
    };
    const day21 = at(21);
    // Left early while in stock: censored out, a day inside the grace boundary.
    expect(day21.has(4)).toBe(false);
    expect(day21.has(12)).toBe(false);
    // Last priced exactly at the horizon less grace: kept, unsold.
    expect(day21.get(11)).toBe(false);
    // Left early and out of stock: sold.
    expect(day21.get(13)).toBe(true);
    // No full horizon before the data ends: absent; exactly one horizon: present.
    expect(day21.has(5)).toBe(false);
    expect(day21.get(15)).toBe(false);
    // A drop on the horizon's last day sells; one after it does not.
    expect(day21.get(16)).toBe(true);
    expect(day21.get(7)).toBe(false);
    expect(at(28).get(7)).toBe(true);
  });

  it("counts only realized sales: a restock never sells or moves the joining entry, and a quantity edit is no sale", () => {
    const entry = (day: number, quantity: number): ForecastHistoryEntry => ({
      listingId: "lst_restock",
      pricedAt: day * DAY_MS,
      quantity,
      forecasts: { curve: 10 },
    });
    const restocked = [entry(0, 1), entry(4, 3), entry(9, 2), entry(30, 2)];
    const unsold = buildForecastCohort(
      restocked,
      ["curve"],
      { saleTimesByListing: new Map(), inStockListingIds: new Set(["lst_restock"]) },
      { horizonDays: 21, graceDays },
    );
    expect(unsold).toEqual([{ listingId: "lst_restock", sold: false, forecasts: { curve: 10 } }]);
    const sold = buildForecastCohort(
      restocked,
      ["curve"],
      { saleTimesByListing: new Map([["lst_restock", [12 * DAY_MS]]]), inStockListingIds: new Set(["lst_restock"]) },
      { horizonDays: 21, graceDays },
    );
    expect(sold).toEqual([{ listingId: "lst_restock", sold: true, forecasts: { curve: 10 } }]);
  });

  it("skips entries without a traced quantity, as the app skipped results without one", () => {
    const entries: ForecastHistoryEntry[] = [
      { listingId: "lst_untraced", pricedAt: 0, quantity: null, forecasts: { curve: 10 } },
      { listingId: "lst_untraced", pricedAt: 30 * DAY_MS, quantity: null, forecasts: { curve: 10 } },
      { listingId: "lst_traced", pricedAt: 0, quantity: 1, forecasts: { curve: 10 } },
      { listingId: "lst_traced", pricedAt: 30 * DAY_MS, quantity: 1, forecasts: { curve: 10 } },
    ];
    const cohort = buildForecastCohort(
      entries,
      ["curve"],
      { saleTimesByListing: new Map(), inStockListingIds: new Set() },
      { horizonDays: 21, graceDays },
    );
    expect(cohort.map((member) => member.listingId)).toEqual(["lst_traced"]);
  });
});
