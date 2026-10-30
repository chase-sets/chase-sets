import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bestCapitalCycle } from "../domain/portfolio/best-capital-cycle";
import {
  fitHorizonValueCurve,
  horizonGainElasticity,
  horizonKneeDays,
  horizonMarginalValuePerDay,
  type HorizonValueCurve,
} from "../domain/portfolio/horizon-value-curve";
import { portfolioHorizonModel } from "../domain/portfolio/preview";
import { scenarioListings } from "./fixtures/portfolio-listings";

const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/app-recorded-portfolio-oracle.json", import.meta.url), "utf8"),
) as Readonly<{
  horizonModel: Readonly<{
    range: Readonly<{ minimumDays: number; maximumDays: number }>;
    samples: readonly Readonly<{ horizonDays: number; value: number }>[];
    curve: HorizonValueCurve;
    kneeDays: number;
    marginalValuePerDayAtKnee: number;
    gainElasticityAtKnee: number;
  }>;
  bestCapitalCycle: Readonly<{
    portfolio: Readonly<{ marketValue: number; unitCount: number }>;
    economics: Parameters<typeof bestCapitalCycle>[2];
    cycle: Readonly<Record<string, number>>;
  }>;
}>;

const recorded = oracle.horizonModel;

describe("the Horizon Value Curve and best Capital Cycle reproduce the pinned app's numbers", () => {
  const model = portfolioHorizonModel({ currencyCode: "USD", listings: scenarioListings("matched") });

  it("samples the one-copy portfolio value at the app's log-spaced horizons", () => {
    expect(model.range).toEqual(recorded.range);
    expect(model.samples).toEqual(
      recorded.samples.map((sample) => ({ horizonDays: sample.horizonDays, valueAmount: sample.value.toFixed(2) })),
    );
  });

  it("fits the same log-logistic curve, knee, marginal value per day and elasticity", () => {
    expect(model.curve).toEqual(recorded.curve);
    expect(model.kneeDays).toBe(recorded.kneeDays);
    expect(horizonKneeDays(recorded.curve)).toBe(recorded.kneeDays);
    expect(horizonMarginalValuePerDay(recorded.curve, recorded.kneeDays)).toBe(recorded.marginalValuePerDayAtKnee);
    expect(horizonGainElasticity(recorded.curve, recorded.kneeDays)).toBe(recorded.gainElasticityAtKnee);
  });

  it("finds the same best capital cycle within the observed range", () => {
    const { portfolio, economics, cycle } = oracle.bestCapitalCycle;
    expect(
      bestCapitalCycle(recorded.curve, portfolio, economics, {
        minimumHorizonDays: recorded.range.minimumDays,
        maximumHorizonDays: recorded.range.maximumDays,
      }),
    ).toEqual(cycle);
  });

  it("answers no curve without three interior samples or positive headroom, and no cycle without profit", () => {
    const samples = recorded.samples.map(({ horizonDays, value }) => ({ horizonDays, value }));
    expect(fitHorizonValueCurve(samples, 100, 100)).toBeNull();
    expect(fitHorizonValueCurve(samples.slice(0, 2), samples[0]!.value, samples.at(-1)!.value)).toBeNull();
    const { portfolio, economics } = oracle.bestCapitalCycle;
    expect(
      bestCapitalCycle(
        recorded.curve,
        portfolio,
        { ...economics, costBasisShareOfMarket: 10 },
        {
          minimumHorizonDays: recorded.range.minimumDays,
          maximumHorizonDays: recorded.range.maximumDays,
        },
      ),
    ).toBeNull();
  });

  it("has no model for a portfolio without an observed sell time", () => {
    expect(portfolioHorizonModel({ currencyCode: "USD", listings: scenarioListings("infeasible") })).toEqual({
      range: null,
      samples: [],
      curve: null,
      kneeDays: null,
    });
  });

  it("searches cycles on the one shared capital-cycle kernel, with no second implementation", () => {
    const search = readFileSync(new URL("../domain/portfolio/best-capital-cycle.ts", import.meta.url), "utf8");
    expect(search).toContain('import { capitalCycle, type CapitalCycle } from "./capital-cycle";');
    expect(search).not.toContain("Math.log(");
  });
});
