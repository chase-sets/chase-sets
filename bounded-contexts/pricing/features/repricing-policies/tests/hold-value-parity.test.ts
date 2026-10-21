import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sumMoneyAmounts } from "@chase-sets/primitives/money";
import { holdValueGoal } from "../domain/goals/hold-value";
import type { PortfolioPlan } from "../domain/portfolio/portfolio";
import { floorConstraint, scenarioListings } from "./fixtures/portfolio-listings";
import { portfolioFixtureBytes, type PortfolioScenarioName } from "./fixtures/portfolio-parity";

type RecordedPlan = Readonly<{
  baselineValue: number;
  selectedOneCopyValue: number;
  valueDifference: number;
  valueTolerance: number;
  matchStatus: PortfolioPlan["status"];
  minimumReachableValue: number;
  maximumReachableValue: number;
  resolvedHorizonDays: number;
  modeledSkuCount: number;
  unavailableBaselineSkuCount: number;
  raisedCount: number;
  loweredCount: number;
  heldCount: number;
  sparseDecisionCount: number;
  cappedHistoryCount: number;
}>;

const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/app-recorded-portfolio-oracle.json", import.meta.url), "utf8"),
) as Readonly<{
  fixture: Readonly<{ sha256: string }>;
  scenarios: Readonly<
    Record<PortfolioScenarioName, Readonly<{ plan: RecordedPlan; decisions: Readonly<Record<string, number>> }>>
  >;
}>;

const scenarios: readonly PortfolioScenarioName[] = [
  "matched",
  "boundary-high",
  "boundary-low",
  "infeasible",
  "one-listing",
];
const money = (value: number) => value.toFixed(2);
const solve = (listings = scenarioListings("matched")) =>
  holdValueGoal.solvePortfolio!({ currencyCode: "USD", listings, parameters: {} });

describe("hold-value reproduces the pinned app's value-matched portfolio plan", () => {
  it("is recorded on the committed fixture", () => {
    expect(createHash("sha256").update(portfolioFixtureBytes).digest("hex")).toBe(oracle.fixture.sha256);
  });

  it.each(scenarios)("on the %s scenario: horizon, match status, value difference and counts", (name) => {
    const recorded = oracle.scenarios[name];
    const plan = solve(scenarioListings(name));
    expect({
      status: plan.status,
      resolvedHorizonDays: plan.resolvedHorizonDays,
      targetValueAmount: plan.targetValueAmount,
      resolvedValueAmount: plan.resolvedValueAmount,
      valueDifferenceAmount: plan.valueDifferenceAmount,
      valueToleranceAmount: plan.valueToleranceAmount,
      reachableValueRange: plan.reachableValueRange,
      modeled: plan.counts.modeled,
      unavailableBaseline: plan.counts.unavailableBaseline,
      raised: plan.counts.raised,
      lowered: plan.counts.lowered,
      held: plan.counts.held,
      sparse: plan.counts.sparse,
      capped: plan.counts.capped,
    }).toEqual({
      status: recorded.plan.matchStatus,
      resolvedHorizonDays: recorded.plan.resolvedHorizonDays,
      targetValueAmount: money(recorded.plan.baselineValue),
      resolvedValueAmount: money(recorded.plan.selectedOneCopyValue),
      valueDifferenceAmount: money(recorded.plan.valueDifference),
      valueToleranceAmount: money(recorded.plan.valueTolerance),
      reachableValueRange: {
        minimumAmount: money(recorded.plan.minimumReachableValue),
        maximumAmount: money(recorded.plan.maximumReachableValue),
      },
      modeled: recorded.plan.modeledSkuCount,
      unavailableBaseline: recorded.plan.unavailableBaselineSkuCount,
      raised: recorded.plan.raisedCount,
      lowered: recorded.plan.loweredCount,
      held: recorded.plan.heldCount,
      sparse: recorded.plan.sparseDecisionCount,
      capped: recorded.plan.cappedHistoryCount,
    });
    const planned = plan.listings.filter((listing) => listing.planPriceAmount !== null);
    expect(Object.fromEntries(planned.map((listing) => [listing.listingId, listing.planPriceAmount]))).toEqual(
      Object.fromEntries(Object.entries(recorded.decisions).map(([listingId, price]) => [listingId, money(price)])),
    );
  });

  it("re-sums the constrained prices it applies, so the plan's value is the value it lists", () => {
    const plan = solve();
    const floored = plan.listings.find((listing) => listing.listingId === "lst_portfolio_06")!;
    expect(floored.decision).toMatchObject({ selectedPriceAmount: "8.00" });
    expect(Number(floored.decision!.unconstrainedPriceAmount)).toBeLessThan(8);
    const planned = plan.listings.flatMap((listing) =>
      listing.planPriceAmount === null ? [] : [listing.planPriceAmount],
    );
    expect(sumMoneyAmounts(planned)).toBe(plan.resolvedValueAmount);
    const unconstrained = plan.listings.flatMap((listing) =>
      listing.decision
        ? [listing.decision.unconstrainedPriceAmount]
        : listing.planPriceAmount
          ? [listing.planPriceAmount]
          : [],
    );
    expect(sumMoneyAmounts(unconstrained)).not.toBe(plan.resolvedValueAmount);
  });

  it("holds a listing without a modeled curve at its current price and never guesses one", () => {
    const held = solve().listings.find((listing) => listing.listingId === "lst_portfolio_07")!;
    expect(held).toEqual({
      listingId: "lst_portfolio_07",
      planPriceAmount: "12.00",
      decision: null,
      heldReason: "curve-feature-missing:storeWinShare",
    });
    const unpriced = solve().listings.find((listing) => listing.listingId === "lst_portfolio_08")!;
    expect(unpriced).toEqual({
      listingId: "lst_portfolio_08",
      planPriceAmount: null,
      decision: null,
      heldReason: "current-price-missing",
    });
  });

  it("identifies the plan by its inputs, never their order", () => {
    const plan = solve();
    const reversed = solve([...scenarioListings("matched")].reverse());
    expect(reversed).toEqual(plan);
    expect(plan.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.planId).toMatch(/^[0-9a-f]{64}$/);
    const tightened = solve(
      scenarioListings("matched").map((listing) =>
        listing.listingId === "lst_portfolio_06" ? { ...listing, constraint: floorConstraint("8.50") } : listing,
      ),
    );
    expect(tightened.snapshotHash).not.toBe(plan.snapshotHash);
    expect(tightened.planId).not.toBe(plan.planId);
  });

  it("rejects a portfolio that lists one listing twice", () => {
    const listings = scenarioListings("matched");
    expect(() => solve([...listings, listings[0]!])).toThrow(
      "A portfolio lists each listing once; repeated: lst_portfolio_01.",
    );
  });
});
