import { describe, expect, it } from "vitest";
import { summarizeHealth, type RepricingHealthContribution } from "../api/health-summary";

const modeled = (listingId: string, currencyCode: string, quantity = 1): RepricingHealthContribution => ({
  listingId,
  quantity,
  currentPriceAmount: "10.00",
  effectivePriceAmount: "12.00",
  currencyCode,
  modeled: {
    medianDays: 4,
    curveVersion: 1,
    builtAt: "2026-10-15T00:00:00.000Z",
    policyRevisionId: "policy-1",
    forecastStatus: "interpolated",
  },
  modeledReason: null,
  economics: {
    resolution: "resolved",
    unitCostAmount: "5.00",
    turnaroundDays: 2,
    dailyReturnHurdle: 0.01,
    sourceKinds: ["inventory-observation", "policy-owned", "pricing-observation"],
    netProceedsAmount: "10.00",
  },
  economicsReason: null,
  risk: "none",
});

describe("durable Pricing Health Summary contract", () => {
  it("keeps the whole population, currencies, weighted waits and economics separate", () => {
    const items = [
      ...Array.from({ length: 501 }, (_, index) => modeled(`usd-${index}`, "USD", index % 3 === 0 ? 2 : 1)),
      modeled("eur-1", "EUR", 3),
      {
        ...modeled("usd-stale", "USD"),
        modeled: null,
        modeledReason: "stale-curve" as const,
        economics: null,
        economicsReason: null,
        risk: "unknown" as const,
      },
      {
        ...modeled("und denominated", "USD"),
        currencyCode: null,
        modeled: null,
        modeledReason: "no-currency" as const,
        economics: null,
        economicsReason: null,
        risk: "unknown" as const,
      },
    ] satisfies readonly RepricingHealthContribution[];
    const summary = summarizeHealth(items, "2026-10-16T00:00:00.000Z");
    expect(summary.population.listingCount).toBe(504);
    expect(summary.population.unitCount).toBeGreaterThan(504);
    expect(summary.currencies.USD.coverage.listingTotal).toBe(502);
    expect(summary.currencies.USD.coverage.listingCount).toBe(501);
    expect(summary.currencies.USD.coverage.missingReasons).toEqual({ "stale-curve": 1 });
    expect(summary.currencies.EUR.coverage.listingCount).toBe(1);
    expect(summary.currencies.USD.expectedWait.medianDays).toBe(4);
    expect(summary.currencies.USD.profitPerDay.economicsListingCount).toBe(501);
    expect(summary.uncategorized.reasons).toEqual({ "no-currency": 1 });
  });
});
