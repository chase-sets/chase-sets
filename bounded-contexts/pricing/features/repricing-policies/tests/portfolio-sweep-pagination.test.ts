import { describe, expect, it } from "vitest";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";
import { cashTargetGoal } from "../domain/goals/cash-target";
import { holdValueGoal } from "../domain/goals/hold-value";
import { assemblePortfolio, type PortfolioPageReader } from "../domain/portfolio/assemble";
import { sweepDailyReturnHurdles, type HurdleSweepListing } from "../domain/portfolio/preview";
import { typicalFeeTerms } from "../../repricing-engine/tests/curve-objective-fixture";
import { resolvedGoalEconomics } from "./fixtures/goal-economics";
import { rescaledParityCurve } from "./fixtures/portfolio-parity";

const economics = resolvedGoalEconomics(typicalFeeTerms, 0.01);

/** 501 synthetic listings in keyset order; some are unmodeled, unpriced or without Economics. */
const portfolio: readonly HurdleSweepListing[] = Array.from({ length: 501 }, (_, index) => {
  const priceScale = 0.5 + (index % 17) / 8;
  return {
    listingId: `lst_page_${String(index).padStart(4, "0")}`,
    currentPriceAmount: index % 97 === 0 ? null : normalizeMoneyAmount((8 * priceScale + (index % 7) / 4).toFixed(2)),
    curve: rescaledParityCurve({
      curve: index % 50 === 0 ? "truncated-supply" : "observed",
      priceScale,
      timeScale: 0.5 + (index % 13) / 6,
    }),
    economics: index % 11 === 0 ? null : economics,
  };
});

function pagedReader(listings: readonly HurdleSweepListing[]) {
  const reads: { after: string | null; limit: number }[] = [];
  const read: PortfolioPageReader<HurdleSweepListing> = async (page) => {
    reads.push(page);
    return listings.filter((listing) => page.after === null || listing.listingId > page.after).slice(0, page.limit);
  };
  return { reads, read };
}

describe("an explicit portfolio is assembled across keyset pages before one deterministic solve and sweep", () => {
  it("loads 501 listings in two pages and solves and sweeps them exactly as one supplied set", async () => {
    const { reads, read } = pagedReader(portfolio);
    const assembled = await assemblePortfolio(read);
    expect(reads).toEqual([
      { after: null, limit: 500 },
      { after: "lst_page_0499", limit: 500 },
    ]);
    expect(assembled).toEqual(portfolio);

    const supplied = [...portfolio].reverse();
    const hold = (listings: readonly HurdleSweepListing[]) =>
      holdValueGoal.solvePortfolio!({ currencyCode: "USD", listings, parameters: {} });
    const paged = hold(assembled);
    expect(paged).toEqual(hold(supplied));
    expect(paged.counts.listings).toBe(501);
    expect(paged.counts.unavailableBaseline).toBe(6);

    const cash = (listings: readonly HurdleSweepListing[]) =>
      cashTargetGoal.solvePortfolio!({ currencyCode: "USD", listings, parameters: { amount: 500, days: 30 } });
    expect(cash(assembled)).toEqual(cash(supplied));
    expect(cash(assembled).snapshotHash).toBe(paged.snapshotHash);

    const sweep = sweepDailyReturnHurdles({ currencyCode: "USD", listings: assembled });
    expect(sweep).toEqual(sweepDailyReturnHurdles({ currencyCode: "USD", listings: supplied }));
    expect(sweep.scenarios.map((scenario) => scenario.dailyReturnHurdle)).toEqual([
      0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02,
    ]);
    expect(sweep.snapshotHash).not.toBe(paged.snapshotHash);
  });

  it("sweeps profit per day at each hurdle, holding listings it cannot model at their current price", () => {
    const sweep = sweepDailyReturnHurdles({
      currencyCode: "USD",
      listings: portfolio.slice(0, 120),
      dailyReturnHurdles: [0.02, 0.001],
    });
    expect(sweep.scenarios.map((scenario) => scenario.dailyReturnHurdle)).toEqual([0.001, 0.02]);
    const [patient, impatient] = sweep.scenarios;
    // A lower hurdle waits longer for more value.
    expect(Number(patient!.oneCopyValueAmount)).toBeGreaterThan(Number(impatient!.oneCopyValueAmount));
    expect(patient!.wait!.medianDays).toBeGreaterThan(impatient!.wait!.medianDays);
    for (const scenario of sweep.scenarios) {
      // Listings 0 and 97 have no current price, so 118 of the 120 have a baseline.
      expect(scenario.raised + scenario.lowered + scenario.held).toBe(118);
      // Of those, 50 and 100 are unmodeled and ten multiples of 11 lack Economics: they are held, never priced.
      expect(scenario.modeled).toBe(118 - 2 - 10);
    }
  });

  it("refuses a page reader that breaks the keyset contract", async () => {
    const backwards: PortfolioPageReader<HurdleSweepListing> = async ({ after }) =>
      after === null ? portfolio.slice(0, 500) : portfolio.slice(499, 501);
    await expect(assemblePortfolio(backwards)).rejects.toThrow(
      "Portfolio page after lst_page_0499 starts at lst_page_0499; keyset pages must advance strictly by listing id.",
    );
    const oversized: PortfolioPageReader<HurdleSweepListing> = async () => portfolio.slice(0, 3);
    await expect(assemblePortfolio(oversized, 2)).rejects.toThrow(
      "Portfolio page returned 3 listings; the limit is 2.",
    );
    const unordered: PortfolioPageReader<HurdleSweepListing> = async () => [portfolio[1]!, portfolio[0]!];
    await expect(assemblePortfolio(unordered, 5)).rejects.toThrow(
      "Portfolio page after the start starts at lst_page_0001 but then lists lst_page_0000; keyset pages must advance strictly by listing id.",
    );
  });
});
