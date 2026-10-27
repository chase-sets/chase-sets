import { describe, expect, it } from "vitest";
import { centsToSignedMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";
import { createPricingHealthWhatIfAdapter } from "../api/portfolio-what-if";
import { portfolioHorizonModel, sweepDailyReturnHurdles } from "../../repricing-policies/domain/portfolio/preview";
import { capitalCycle } from "../../repricing-policies/domain/portfolio/capital-cycle";
import { netProceedsAtPrice } from "../../repricing-policies/domain/goals/curve-math";
import {
  assembledWhatIfListings,
  whatIfDb,
  whatIfEconomics,
  whatIfListing,
  whatIfNow,
} from "./portfolio-what-if-fixture";

async function read(rows = [whatIfListing(0)], fee = 1000, cost = 7000, curveCurrency: string | null = "USD") {
  const { db } = whatIfDb(rows, curveCurrency);
  return createPricingHealthWhatIfAdapter({
    db,
    economics: { resolve: async () => whatIfEconomics(fee, 0.0035, cost) },
  }).get("acc", whatIfNow);
}

describe("Pricing Health what-if regression contracts", () => {
  it("binds every complete paged reference-id portfolio to the assembled solver inputs and finite controls (M1 M3 M4 M5)", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => whatIfListing(index));
    const { db, pages } = whatIfDb(rows);
    const result = await createPricingHealthWhatIfAdapter({
      db,
      economics: { resolve: async () => whatIfEconomics() },
    }).get("acc", whatIfNow);
    expect(pages).toEqual([
      ["acc", null, 500],
      ["acc", "lst-0499", 500],
    ]);
    expect(
      result.portfolios.map(({ key, productLineReferenceId, listingCount }) => ({
        key,
        productLineReferenceId,
        listingCount,
      })),
    ).toEqual([
      { key: "overall", productLineReferenceId: null, listingCount: 501 },
      { key: "line-a", productLineReferenceId: "line-a", listingCount: 167 },
      { key: "line-b", productLineReferenceId: "line-b", listingCount: 167 },
      { key: "__none__", productLineReferenceId: null, listingCount: 167 },
    ]);
    expect(result.portfolios[3]!.label).toBe("No product line");
    for (const [index, portfolio] of result.portfolios.entries()) {
      const selected = index === 0 ? rows : rows.filter((_, rowIndex) => rowIndex % 3 === index - 1);
      const input = { currencyCode: "USD", listings: assembledWhatIfListings(selected) };
      const sweep = sweepDailyReturnHurdles(input);
      expect(portfolio.snapshotHash).toBe(sweep.snapshotHash);
      expect(portfolio.horizon).toEqual(
        expect.objectContaining({
          samples: portfolioHorizonModel(input).samples,
          kneeDays: portfolioHorizonModel(input).kneeDays,
        }),
      );
      expect(portfolio.hurdle.scenarios.map(({ dailyReturn: _dailyReturn, ...scenario }) => scenario)).toEqual(
        sweep.scenarios,
      );
      expect(portfolio.horizon.samples.length).toBeGreaterThan(1);
      expect(
        portfolio.horizon.samples.every(
          (sample) => Number.isFinite(sample.horizonDays) && Number.isFinite(Number(sample.valueAmount)),
        ),
      ).toBe(true);
      expect(
        portfolio.hurdle.scenarios.every(
          (scenario) => Number.isFinite(scenario.dailyReturnHurdle) && Number.isFinite(scenario.dailyReturn),
        ),
      ).toBe(true);
      expect(portfolio.hurdle.best?.dailyReturn).toBeGreaterThan(0);
      expect(portfolio.hurdle.scenarios[0]!.oneCopyValueAmount).not.toBe(
        portfolio.hurdle.scenarios.at(-1)!.oneCopyValueAmount,
      );
    }
  });

  it("pays each listing's overhead and keeps Economics-less value out of the capital cycle (F1)", async () => {
    const zero = (await read(undefined, 0)).portfolios[0]!;
    const high = (await read(undefined, 5000)).portfolios[0]!;
    expect(zero.hurdle.scenarios.map((scenario) => scenario.dailyReturn)).not.toEqual(
      high.hurdle.scenarios.map((scenario) => scenario.dailyReturn),
    );
    const extra = (await read([whatIfListing(0), whatIfListing(1, "USD", false), whatIfListing(2, "USD", false)], 0))
      .portfolios[0]!;
    expect(extra.hurdle.scenarios.map((scenario) => scenario.dailyReturn)).toEqual(
      zero.hurdle.scenarios.map((scenario) => scenario.dailyReturn),
    );
    expect(extra.hurdle.best).toEqual(zero.hurdle.best);
    const listing = assembledWhatIfListings([whatIfListing(0)], whatIfEconomics(5000))[0]!;
    const scenario = sweepDailyReturnHurdles({ currencyCode: "USD", listings: [listing] }).scenarios[0]!;
    if (listing.economics?.availability !== "resolved") throw new Error("fixture must resolve");
    expect(high.hurdle.scenarios[0]!.dailyReturn).toBe(
      capitalCycle(
        netProceedsAtPrice(Number(scenario.oneCopyValueAmount), listing.economics),
        7,
        scenario.wait!.medianDays,
        28,
      ).dailyReturn,
    );
  });

  it("compares the exact configured 0.0035 scenario and returns exact signed cents (F1 F4)", async () => {
    const portfolio = (await read()).portfolios[0]!;
    const input = {
      currencyCode: "USD",
      listings: assembledWhatIfListings([whatIfListing(0)]),
      dailyReturnHurdles: [0.0035],
    };
    const configured = sweepDailyReturnHurdles(input).scenarios[0]!;
    const best = portfolio.hurdle.best!;
    expect(portfolio.hurdle.valueDeltaAmount).toBe(
      centsToSignedMoneyAmount(moneyToCents(best.valueAmount) - moneyToCents(configured.oneCopyValueAmount)),
    );
    expect(typeof portfolio.hurdle.valueDeltaAmount).toBe("string");
    expect(portfolio.hurdle.waitDeltaDays).toBe(best.waitDays! - configured.wait!.medianDays);
  });

  it("leaves the cycle unavailable without resolved Economics and deltas unavailable for multiple configured hurdles (F1)", async () => {
    const empty = (await read([whatIfListing(0, "USD", false)])).portfolios[0]!;
    expect(empty.hurdle.scenarios.every((scenario) => scenario.dailyReturn === null)).toBe(true);
    expect(empty.hurdle.best).toBeNull();
    const { db } = whatIfDb([whatIfListing(0), whatIfListing(1)]);
    const mixed = await createPricingHealthWhatIfAdapter({
      db,
      economics: {
        resolve: async (request) => whatIfEconomics(1000, request.inventoryItemId === "inv-0" ? 0.0035 : 0.007),
      },
    }).get("acc", whatIfNow);
    expect(mixed.portfolios[0]!.hurdle.configuredDailyReturnHurdles).toEqual([0.0035, 0.007]);
    expect(mixed.portfolios[0]!.hurdle.best).not.toBeNull();
    expect(mixed.portfolios[0]!.hurdle.valueDeltaAmount).toBeNull();
    expect(mixed.portfolios[0]!.hurdle.waitDeltaDays).toBeNull();
  });

  it("has no Best when every scenario loses money (M2)", async () => {
    const portfolio = (await read(undefined, 5000, 10000)).portfolios[0]!;
    expect(
      portfolio.hurdle.scenarios.some((scenario) => scenario.dailyReturn !== null && scenario.dailyReturn < 0),
    ).toBe(true);
    expect(portfolio.hurdle.best).toBeNull();
    expect(portfolio.hurdle.valueDeltaAmount).toBeNull();
    expect(portfolio.hurdle.waitDeltaDays).toBeNull();
  });

  it("excludes other and absent currencies and treats null or mismatched curves as unmodeled (F2)", async () => {
    const usd = (await read()).portfolios[0]!;
    const mixed = (
      await read([whatIfListing(0), { ...whatIfListing(1, "EUR"), price_amount: "1000.00" }, whatIfListing(2, null)])
    ).portfolios[0]!;
    expect(mixed.horizon).toEqual(usd.horizon);
    expect(mixed.hurdle).toEqual(usd.hurdle);
    expect(mixed.excludedCurrencyCount).toBe(2);
    for (const currency of [null, "EUR"]) {
      const result = (await read(undefined, 1000, 7000, currency)).portfolios[0]!;
      expect(result.horizon.samples).toEqual([]);
      expect(result.hurdle.scenarios.every((scenario) => scenario.modeled === 0)).toBe(true);
    }
  });
});
