import { describe, expect, it } from "vitest";
import { moneyToCents, signedMoneyToCents } from "@chase-sets/primitives/money";
import { saleProbability } from "../../forecast-ledger/domain/grading";
import { cashTargetGoal } from "../domain/goals/cash-target";
import { decideAtPoint, pointAtSellTime, toGoalCurveViews } from "../domain/goals/curve-math";
import { logSpacedHorizons } from "../domain/portfolio/search";
import type { PortfolioListing, PortfolioPlan } from "../domain/portfolio/portfolio";
import { scenarioListings } from "./fixtures/portfolio-listings";

/** The matched portfolio without its synthetic constraint, so a second path can price it from the curves alone. */
const listings: readonly PortfolioListing[] = scenarioListings("matched").map(
  ({ constraint: _, ...listing }) => listing,
);

/**
 * Expected Realized Value in cents at one horizon, computed apart from the
 * solver: each modeled listing's target-horizon price times its chance of a
 * sale within the window, from the forecast read back at that price.
 */
function expectedRealizedCents(horizonDays: number, windowDays: number): number {
  return listings.reduce((sum, listing) => {
    const views =
      listing.currentPriceAmount === null || listing.curve === null ? null : toGoalCurveViews(listing.curve.points);
    if (!views || views.bySellTime.length === 0) return sum;
    const { selectedPrice, forecast } = decideAtPoint(views, pointAtSellTime(views.bySellTime, horizonDays));
    return forecast.status === "unavailable" || !(forecast.medianSellDays! > 0)
      ? sum
      : sum + Math.round(selectedPrice * 100) * saleProbability(forecast.medianSellDays!, windowDays);
  }, 0);
}

const range = { minimumDays: 0.18714973875118524, maximumDays: 991.2004682007217 };
const sampled = (windowDays: number) =>
  logSpacedHorizons(range.minimumDays, range.maximumDays, 97).map((horizonDays) =>
    expectedRealizedCents(horizonDays, windowDays),
  );
const solve = (amount: number, days: number, portfolio: readonly PortfolioListing[] = listings): PortfolioPlan =>
  cashTargetGoal.solvePortfolio!({ currencyCode: "USD", listings: portfolio, parameters: { amount, days } });
const cents = (amount: string) => Number(moneyToCents(amount));

describe("cash-target solves for the horizon whose Expected Realized Value meets the target", () => {
  it("meets a reachable target at the longest horizon that still meets it", () => {
    const amount = Math.round(Math.max(...sampled(30)) * 0.6) / 100;
    const plan = solve(amount, 30);
    expect(plan.status).toBe("matched");
    expect(plan.targetValueAmount).toBe(amount.toFixed(2));
    const realized = expectedRealizedCents(plan.resolvedHorizonDays, 30);
    expect(Math.abs(realized - cents(plan.resolvedValueAmount))).toBeLessThanOrEqual(0.5);
    expect(realized).toBeGreaterThanOrEqual(cents(plan.targetValueAmount) - cents(plan.valueToleranceAmount));
    expect(expectedRealizedCents(plan.resolvedHorizonDays * 1.05, 30)).toBeLessThan(cents(plan.targetValueAmount));
    expect(Number(signedMoneyToCents(plan.valueDifferenceAmount))).toBe(
      cents(plan.resolvedValueAmount) - cents(plan.targetValueAmount),
    );
  });

  it("re-sums its own per-listing decisions into the Expected Realized Value it reports", () => {
    const plan = solve(Math.round(Math.max(...sampled(30)) * 0.6) / 100, 30);
    const resummed = plan.listings.reduce((sum, listing) => {
      const forecast = listing.decision?.forecast;
      return !forecast || forecast.status === "unavailable" || !(forecast.medianSellDays! > 0)
        ? sum
        : sum + cents(listing.decision!.selectedPriceAmount) * saleProbability(forecast.medianSellDays!, 30);
    }, 0);
    expect(Math.round(resummed)).toBe(cents(plan.resolvedValueAmount));
  });

  it("reports a boundary at the most reachable value, with the reachable range, when the target is out of reach", () => {
    const plan = solve(1_000_000, 30);
    expect(plan.status).toBe("boundary");
    expect(plan.resolvedValueAmount).toBe(plan.reachableValueRange.maximumAmount);
    expect(cents(plan.reachableValueRange.minimumAmount)).toBeLessThan(cents(plan.reachableValueRange.maximumAmount));
    expect(Number(signedMoneyToCents(plan.valueDifferenceAmount))).toBeLessThan(0);
    const best = expectedRealizedCents(plan.resolvedHorizonDays, 30);
    for (const value of sampled(30)) expect(best).toBeGreaterThanOrEqual(value - 0.5);
  });

  it("prices at the longest horizon when every horizon meets the target", () => {
    const plan = solve(0.01, 30);
    expect(plan.status).toBe("matched");
    expect(plan.resolvedHorizonDays).toBe(range.maximumDays);
  });

  it("never shortens the horizon when the window lengthens", () => {
    const amount = Math.round(Math.max(...sampled(14)) * 0.5) / 100;
    expect(solve(amount, 60).resolvedHorizonDays).toBeGreaterThanOrEqual(solve(amount, 14).resolvedHorizonDays);
  });

  it("is infeasible without a modeled listing, and holds every listing at its current price", () => {
    const plan = solve(100, 30, scenarioListings("infeasible"));
    expect(plan.status).toBe("infeasible");
    expect(plan.listings.map((listing) => [listing.listingId, listing.planPriceAmount, listing.heldReason])).toEqual([
      ["lst_portfolio_07", "12.00", "curve-feature-missing:storeWinShare"],
      ["lst_portfolio_08", null, "current-price-missing"],
    ]);
  });

  it("decides one listing as the plan of a one-listing portfolio", () => {
    const listing = listings[0]!;
    const parameters = { amount: 5, days: 30 };
    const plan = cashTargetGoal.solvePortfolio!({ currencyCode: "USD", listings: [listing], parameters });
    expect(
      cashTargetGoal.solve({
        curve: listing.curve!,
        economics: null,
        parameters,
        currentPriceAmount: listing.currentPriceAmount,
      }),
    ).toEqual(plan.listings[0]!.decision);
  });
});
