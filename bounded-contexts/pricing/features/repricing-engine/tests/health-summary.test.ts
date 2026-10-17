import { describe, expect, it } from "vitest";
import { buildHealthContributions, summarizeHealth, type RepricingHealthContribution } from "../api/health-summary";
import type { RepricingRoundListing } from "../read-model/queries";
import type { RepricingPolicyListingTrace } from "../domain/fact";
import type { DemandCurveWithPoints } from "../../market-estimates/read-model/demand-curve-queries";

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
    costBasisSourceKinds: ["inventory-observation", "policy-owned"],
    dailyReturnHurdleSourceKind: "pricing-observation",
    netProceedsAmount: "10.00",
  },
  economicsReason: null,
  risk: "none",
});

describe("durable Pricing Health Summary contract", () => {
  it("resolves modeled listings sequentially and propagates thrown failures as named errors", async () => {
    const listing: RepricingRoundListing = {
      listingId: "lst_synthetic_a",
      sellerAccountId: "acc_synthetic",
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "prod_synthetic",
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      listingVersion: 1,
      listingStatus: "active",
      pauseReason: null,
      categoryIds: [],
      grading: null,
      createdAt: null,
      costBasisAmount: null,
      costBasisCurrencyCode: null,
      policyId: "rpp_synthetic",
      policyRevision: "synthetic",
      rules: [],
      maxChangesPerDay: 100,
      economics: null,
    };
    const listings = [listing, { ...listing, listingId: "lst_synthetic_b" }];
    const traces: RepricingPolicyListingTrace[] = listings.map((item) => ({
      listingId: item.listingId,
      currentPriceAmount: item.priceAmount,
      targetPriceAmount: null,
      ruleIndex: 0,
      anchor: null,
      exhaustedAnchors: [],
      clamps: { floor: false, ceiling: false, maxMove: false },
      flags: [],
      outcome: "skipped",
      skipReason: null,
    }));
    const curve: DemandCurveWithPoints = {
      catalogItemId: listing.catalogItemId,
      productId: listing.productId,
      version: 1,
      providerCondition: "Near Mint",
      providerVariant: "Normal",
      providerLanguage: "English",
      fingerprint: "synthetic",
      modelVersion: "synthetic",
      policyRevisionId: "fallback",
      ladderMethod: "synthetic",
      anchorCondition: null,
      exposureStartReason: "synthetic",
      salesCoverage: "synthetic",
      supplyStatus: "observed",
      ownSellerExclusionApplied: true,
      builtAt: "2026-10-15T00:00:00.000Z",
      freshUntil: "2026-10-17T00:00:00.000Z",
      currencyCode: "USD",
      points: [
        {
          percentile: 50,
          priceAmount: "10.00",
          buyerArrivalIntervalDays: null,
          competingSellerCount: null,
          storeWinShare: null,
          medianSellDays: 4,
          qualifyingSaleCount: 1,
          historyCapped: false,
          hopeless: false,
          supplyStatus: "observed",
          salesCoverage: "synthetic",
        },
      ],
    };
    const curves = new Map([[JSON.stringify([listing.catalogItemId, listing.productId]), curve]]);
    let active = 0;
    let peak = 0;
    const contributions = await buildHealthContributions(
      listings,
      traces,
      curves,
      new Map(),
      "2026-10-16T00:00:00.000Z",
      async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return { resolution: null, marketUnitPriceAmount: "10.00" };
      },
    );
    expect(peak).toBe(1);
    expect(contributions.map((item) => item.economicsReason)).toEqual([
      "inventory-item-missing",
      "inventory-item-missing",
    ]);
    const outage = new Error("synthetic programming failure");
    await expect(
      buildHealthContributions(listings, traces, curves, new Map(), "2026-10-16T00:00:00.000Z", async () => {
        throw outage;
      }),
    ).rejects.toMatchObject({ name: "RepricingEconomicsResolveError", cause: outage });
  });

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
    expect(summary.currencies.USD.profitPerDay.costBasisSourceKinds).toEqual({
      "inventory-observation": 501,
      "policy-owned": 501,
    });
    expect(summary.currencies.USD.capitalTurn.dailyReturnHurdleSourceKinds).toEqual({ "pricing-observation": 501 });
    expect(summary.uncategorized.reasons).toEqual({ "no-currency": 1 });
  });

  it("weights tied median waits by units rather than listings and keeps cent totals exact", () => {
    const items = [
      {
        ...modeled("z", "USD", 1),
        currentPriceAmount: "0.10",
        effectivePriceAmount: "0.10",
        modeled: { ...modeled("z", "USD").modeled!, medianDays: 1 },
      },
      {
        ...modeled("a", "USD", 9),
        currentPriceAmount: "0.20",
        effectivePriceAmount: "0.20",
        modeled: { ...modeled("a", "USD").modeled!, medianDays: 10 },
      },
      {
        ...modeled("A", "USD", 2),
        currentPriceAmount: "0.20",
        effectivePriceAmount: "0.20",
        modeled: { ...modeled("A", "USD").modeled!, medianDays: 10 },
      },
      {
        ...modeled("last", "USD", 1),
        currentPriceAmount: "0.10",
        effectivePriceAmount: "0.10",
        modeled: { ...modeled("last", "USD").modeled!, medianDays: 100 },
      },
    ];
    const usd = summarizeHealth(items, "2026-10-16T00:00:00.000Z").currencies.USD!;
    expect(usd.expectedWait).toEqual({ medianDays: 10, p90Days: 10 });
    expect(usd.listedValueAmount).toBe("2.40");
    expect(usd.modeledValueAmount).toBe("2.40");
    expect(usd.modeledValueDeltaAmount).toBe("0.00");
  });
});
